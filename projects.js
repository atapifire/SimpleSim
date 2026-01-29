import { state, supabase, events, projectCache } from './state.js';
import { renderProject } from './renderer.js';
import { showToast } from './utils.js';
import { autoCreateRepoIfEnabled, autoCommitIfLinked } from './github.js';
import { devLog, devError } from './thinking.js';

const PROJECT_MENU_HTML = `
<div id="project-menu" class="absolute bottom-full left-0 mb-3 ml-2 w-64 bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-xl shadow-2xl transform origin-bottom-left transition-all duration-200 opacity-0 pointer-events-none translate-y-2 z-50 flex flex-col">
    <div class="p-2 border-b border-gray-700/50">
        <input id="project-search" type="text" placeholder="Search projects..." class="w-full bg-gray-800 text-gray-200 text-xs p-2 rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none placeholder-gray-500">
    </div>
    <div id="project-list" class="max-h-60 overflow-y-auto p-1 custom-scrollbar space-y-0.5"></div>
</div>`;

export function initProjects() {
    // Inject menu into input-bar container
    const inputBar = document.getElementById('input-bar');
    if (inputBar) inputBar.insertAdjacentHTML('afterbegin', PROJECT_MENU_HTML);

    setupListeners();

    // Listen for auth changes to reload projects
    events.addEventListener('auth-changed', () => {
        if (state.user) {
            fetchProjects();
            if (state.projectId) loadProject(state.projectId);
        } else {
            // Clear caches on logout
            projectCache.clearAll();
            state.projects = [];
            renderProjectList();
            resetToNewProject();
        }
    });

    // Initial load if already authenticated
    if (state.user) {
        fetchProjects();
        if (state.projectId) loadProject(state.projectId);
    } else {
        resetToNewProject();
    }
}

function setupListeners() {
    const btnLabel = document.getElementById('btn-project-label');
    const btnNew = document.getElementById('btn-new-project');
    const search = document.getElementById('project-search');
    const btnHistory = document.getElementById('btn-history');
    const closeHistory = document.getElementById('close-history');

    btnLabel?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleProjectMenu();
    });

    btnNew?.addEventListener('click', (e) => {
        e.preventDefault();
        resetToNewProject();
        showToast("Started new project");
    });

    search?.addEventListener('input', (e) => renderProjectList(e.target.value));

    // Close menu on outside click
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('project-menu');
        if (state.projectMenuOpen && menu && !menu.contains(e.target) && !btnLabel.contains(e.target)) {
            toggleProjectMenu(false);
        }
    });

    btnHistory?.addEventListener('click', toggleHistory);
    closeHistory?.addEventListener('click', toggleHistory);
}

async function fetchProjects(forceRefresh = false) {
    if (!state.user) return;

    // Check cache first (unless forced refresh)
    if (!forceRefresh) {
        const cached = projectCache.getProjects();
        if (cached) {
            devLog('Using cached projects list');
            state.projects = cached;
            renderProjectList();
            updateCurrentProjectName();
            return;
        }
    }

    devLog('Fetching projects from Supabase...');
    const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error fetching projects:', error);
        return;
    }

    state.projects = data || [];
    projectCache.setProjects(state.projects); // Cache the result
    renderProjectList();
    updateCurrentProjectName();
}

function updateCurrentProjectName() {
    if (state.projectId) {
        const current = state.projects.find(p => p.id === state.projectId);
        if (current) {
            state.projectName = current.name;
            document.getElementById('current-project-name').textContent = state.projectName;
        }
    }
}

export async function createProject(name) {
    if (!state.user) throw new Error('Not authenticated');

    const { data, error } = await supabase
        .from('projects')
        .insert({
            user_id: state.user.id,
            name,
        })
        .select()
        .single();

    if (error) {
        console.error('Error creating project:', error);
        throw error;
    }

    // Add to local state
    state.projects.unshift(data);
    renderProjectList();

    // Auto-create GitHub repo if enabled
    try {
        await autoCreateRepoIfEnabled(data.id, name);
    } catch (e) {
        console.error('Auto-create repo skipped:', e);
    }

    return data;
}

export async function createVersion(projectId, { prompt, files, description, modelUsed }) {
    if (!state.user) throw new Error('Not authenticated');
    if (!projectId) throw new Error('No project ID provided');
    if (!files || !Array.isArray(files) || files.length === 0) {
        throw new Error('No files to save');
    }

    devLog('Creating version for project:', projectId);
    devLog('Files to save:', files.map(f => f.path));

    const { data, error } = await supabase
        .from('versions')
        .insert({
            project_id: projectId,
            prompt,
            files, // Already JSON, Supabase handles JSONB
            description: description || `Generated from: ${prompt.slice(0, 100)}...`,
            model_used: modelUsed || state.settings.openRouterModel,
        })
        .select()
        .single();

    if (error) {
        devError('Error creating version:', error);
        throw error;
    }

    devLog('Version created:', data.id);

    // Update project's current_files
    const { error: updateError } = await supabase
        .from('projects')
        .update({ current_files: files })
        .eq('id', projectId);

    if (updateError) {
        devError('Error updating project files:', updateError);
    }

    // Create version object
    const newVersion = {
        id: data.id,
        prompt: data.prompt,
        files: data.files,
        timestamp: new Date(data.created_at),
        description: data.description
    };

    // Add to local versions and re-render
    state.versions.push(newVersion);
    state.currentVersionIndex = state.versions.length - 1;

    // Update cache with new version (avoids full re-fetch)
    projectCache.addVersionToCache(projectId, newVersion);

    devLog('Rendering project with', files.length, 'files');
    renderProject(files);
    updateHistoryUI();

    // Notify UI to update health indicator
    events.dispatchEvent(new CustomEvent('version-changed'));

    // Auto-sync to GitHub if enabled and repo is linked
    devLog('Checking GitHub auto-sync...');
    try {
        const commitResult = await autoCommitIfLinked(projectId, files, prompt);
        if (commitResult) {
            devLog('GitHub commit successful:', commitResult.sha);
        }
    } catch (e) {
        devError('Auto-sync failed:', e);
    }

    return data;
}

export function resetToNewProject() {
    state.projectId = null;
    state.projectName = "New Project";
    state.versions = [];
    state.currentVersionIndex = -1;

    document.getElementById('current-project-name').textContent = state.projectName;
    document.getElementById('welcome-screen')?.classList.remove('hidden');
    const preview = document.getElementById('site-preview');
    if (preview) preview.srcdoc = '';
    document.getElementById('project-loader')?.classList.add('hidden');
    updateHistoryUI();

    const url = new URL(window.location);
    url.searchParams.delete('project');
    window.history.replaceState({}, '', url);

    if (state.historyOpen) toggleHistory();
    toggleProjectMenu(false);
}

// Clear all caches (called on logout)
export function clearProjectCaches() {
    projectCache.clearAll();
    devLog('Project caches cleared');
}

export async function loadProject(id, forceRefresh = false) {
    if (!id || !state.user) return;
    state.projectId = id;
    localStorage.setItem('last_project_id', id);

    const p = state.projects.find(proj => proj.id === id);
    if (p) state.projectName = p.name;
    document.getElementById('current-project-name').textContent = state.projectName || "Loading...";

    const url = new URL(window.location);
    url.searchParams.set('project', id);
    window.history.replaceState({}, '', url);

    // Check cache first for instant load
    if (!forceRefresh) {
        const cachedVersions = projectCache.getVersions(id);
        if (cachedVersions && cachedVersions.length > 0) {
            devLog('Using cached versions for project:', id);
            state.versions = cachedVersions.map(r => ({
                ...r,
                timestamp: new Date(r.timestamp || r.created_at)
            }));
            state.currentVersionIndex = state.versions.length - 1;

            // Use cached files if available for instant render
            const cachedFiles = projectCache.getCurrentFiles(id);
            if (cachedFiles) {
                renderProject(cachedFiles);
            } else {
                renderProject(getCurrentFiles());
            }

            document.getElementById('welcome-screen')?.classList.add('hidden');
            document.getElementById('project-loader')?.classList.add('hidden');
            events.dispatchEvent(new CustomEvent('version-changed'));
            updateHistoryUI();
            toggleProjectMenu(false);
            return;
        }
    }

    // Show loader for non-cached loads
    state.versions = [];
    state.currentVersionIndex = -1;
    const preview = document.getElementById('site-preview');
    if (preview) preview.srcdoc = '';
    document.getElementById('project-loader')?.classList.remove('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    updateHistoryUI();

    devLog('Fetching versions from Supabase for project:', id);

    // Fetch versions from Supabase
    const { data, error } = await supabase
        .from('versions')
        .select('*')
        .eq('project_id', id)
        .order('created_at', { ascending: true });

    document.getElementById('project-loader')?.classList.add('hidden');

    if (error) {
        console.error('Error loading versions:', error);
        showToast('Failed to load project');
        return;
    }

    state.versions = (data || []).map(r => ({
        id: r.id,
        prompt: r.prompt,
        files: r.files, // Already parsed by Supabase
        timestamp: new Date(r.created_at),
        description: r.description
    }));

    // Cache the versions
    projectCache.setVersions(id, state.versions);

    if (state.versions.length > 0) {
        state.currentVersionIndex = state.versions.length - 1;
        const files = getCurrentFiles();
        projectCache.setCurrentFiles(id, files); // Cache current files
        renderProject(files);
        events.dispatchEvent(new CustomEvent('version-changed'));
    } else {
        document.getElementById('welcome-screen')?.classList.remove('hidden');
    }

    updateHistoryUI();
    toggleProjectMenu(false);
}

export function getCurrentFiles() {
    if (state.currentVersionIndex === -1 || !state.versions.length) return null;
    if (state.currentVersionIndex >= state.versions.length) state.currentVersionIndex = state.versions.length - 1;
    return state.versions[state.currentVersionIndex].files;
}

function renderProjectList(filterText = '') {
    const list = document.getElementById('project-list');
    if (!list) return;
    list.innerHTML = '';

    if (!state.user) {
        list.innerHTML = '<div class="text-gray-500 text-xs text-center py-4">Sign in to see projects</div>';
        return;
    }

    const filtered = state.projects.filter(p => p.name.toLowerCase().includes(filterText.toLowerCase()));

    if (filtered.length === 0) {
        list.innerHTML = '<div class="text-gray-500 text-xs text-center py-4">No projects found</div>';
        return;
    }

    filtered.forEach(p => {
        const isActive = p.id === state.projectId;
        const el = document.createElement('div');
        el.className = `p-2 rounded-lg cursor-pointer flex justify-between items-center group transition-colors ${isActive ? 'bg-blue-900/30 text-blue-200' : 'hover:bg-gray-800 text-gray-300'}`;
        el.innerHTML = `<div class="truncate text-xs font-medium pr-2">${p.name}</div><div class="text-[10px] text-gray-500 font-mono opacity-0 group-hover:opacity-100 transition-opacity">${new Date(p.created_at).toLocaleDateString()}</div>`;
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            loadProject(p.id);
        });
        list.appendChild(el);
    });
}

function toggleProjectMenu(forceState) {
    state.projectMenuOpen = typeof forceState === 'boolean' ? forceState : !state.projectMenuOpen;
    const menu = document.getElementById('project-menu');

    if (state.projectMenuOpen) {
        menu?.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-2');
        menu?.classList.add('opacity-100', 'pointer-events-auto', 'translate-y-0');
        document.getElementById('project-search')?.focus();
    } else {
        menu?.classList.add('opacity-0', 'pointer-events-none', 'translate-y-2');
        menu?.classList.remove('opacity-100', 'pointer-events-auto', 'translate-y-0');
    }
}

function toggleHistory() {
    state.historyOpen = !state.historyOpen;
    const p = document.getElementById('history-panel');
    const inputBar = document.getElementById('input-bar');

    if (state.historyOpen) {
        p?.classList.remove('opacity-0', 'translate-y-full', 'pointer-events-none');
        p?.classList.add('opacity-100', 'translate-y-0', 'pointer-events-auto');
        if (inputBar) {
            inputBar.classList.remove('rounded-2xl');
            inputBar.classList.add('rounded-b-2xl', 'rounded-t-sm');
        }
        updateHistoryUI();
    } else {
        p?.classList.add('opacity-0', 'translate-y-full', 'pointer-events-none');
        p?.classList.remove('opacity-100', 'translate-y-0', 'pointer-events-auto');
        if (inputBar) {
            inputBar.classList.add('rounded-2xl');
            inputBar.classList.remove('rounded-b-2xl', 'rounded-t-sm');
        }
    }
}

function updateHistoryUI() {
    const list = document.getElementById('history-list');
    const badge = document.getElementById('version-badge');

    if (state.versions.length > 0) badge?.classList.remove('hidden');
    else badge?.classList.add('hidden');

    if (!list) return;

    if (state.versions.length === 0) {
        list.innerHTML = `<div class="flex flex-col items-center justify-center h-32 text-gray-500 space-y-2 opacity-50 select-none"><i class="fa-solid fa-code-branch text-3xl"></i><p class="text-xs font-medium">No version history</p></div>`;
        return;
    }

    list.innerHTML = '';
    // Display oldest at top, newest at bottom (chronological order)
    state.versions.forEach((ver, index) => {
        const isActive = index === state.currentVersionIndex;
        const el = document.createElement('div');
        el.className = `p-3 rounded-lg border cursor-pointer transition-all ${isActive ? 'bg-blue-900/30 border-blue-500' : 'bg-gray-800 border-gray-700 hover:bg-gray-750'}`;
        el.innerHTML = `
            <div class="flex justify-between items-start mb-1"><span class="text-xs font-mono text-gray-500">#${ver.id.substring(0, 8)}</span><span class="text-xs text-gray-400">${ver.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
            <div class="font-medium text-sm text-gray-200 mb-1 line-clamp-2">${ver.prompt}</div>
            <div class="text-xs text-gray-500 flex items-center gap-2">${isActive ? '<span class="text-blue-400 font-bold">● Current</span>' : ''}<span>${ver.description || ''}</span></div>`;
        el.addEventListener('click', () => {
            state.currentVersionIndex = index;
            renderProject(ver.files);
            updateHistoryUI();
            showToast(`Restored version ${ver.id.substring(0, 8)}`);
        });
        list.appendChild(el);
    });

    // Auto-scroll to show current version (newest at bottom)
    if (state.currentVersionIndex === state.versions.length - 1) {
        list.scrollTop = list.scrollHeight;
    }
}

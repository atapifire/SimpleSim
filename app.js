import { state, supabase, events, initAuth, signInWithGitHub, signOut } from './state.js';
import { security } from './security.js';
import { showToast, setLoading, setupVoiceInput } from './utils.js';
import { initSettings, startPinFlow } from './settings.js';
import { initProjects, loadProject, getCurrentFiles, createProject, createVersion } from './projects.js';
import { generateProject, checkCredits, fetchModelsWithCredits } from './ai.js';

// --- Initialization ---
async function init() {
    // Initialize auth first
    await initAuth();

    // Inject auth UI
    injectAuthUI();

    // Inject model selector dropdown
    injectModelSelector();

    initSettings();
    initProjects();
    setupEventListeners();
    setupModelSelector();

    // Resume previous project if ID exists AND user is logged in
    if (state.projectId && state.user) {
        await loadProject(state.projectId);
    }

    document.getElementById('prompt-input')?.focus();

    // Update model display
    updateModelDisplay();
}

// Inject login/logout button into the UI
function injectAuthUI() {
    const authContainer = document.createElement('div');
    authContainer.id = 'auth-container';
    authContainer.className = 'fixed top-4 right-4 z-50 pointer-events-auto';
    authContainer.innerHTML = `
        <div id="auth-loading" class="hidden">
            <div class="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin"></div>
        </div>
        <button id="btn-login" class="hidden bg-gray-800/90 backdrop-blur-lg border border-gray-700 px-4 py-2 rounded-xl text-sm font-medium text-white hover:bg-gray-700 transition-colors flex items-center gap-2">
            <i class="fa-brands fa-github"></i>
            Sign in with GitHub
        </button>
        <div id="user-menu" class="hidden flex items-center gap-3">
            <img id="user-avatar" src="" class="w-8 h-8 rounded-full border-2 border-gray-700" alt="Avatar">
            <span id="user-name" class="text-sm text-gray-300 hidden sm:block"></span>
            <button id="btn-logout" class="bg-gray-800/90 backdrop-blur-lg border border-gray-700 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                Sign out
            </button>
        </div>
    `;
    document.body.appendChild(authContainer);

    // Auth event listeners
    document.getElementById('btn-login')?.addEventListener('click', async () => {
        try {
            await signInWithGitHub();
        } catch (error) {
            showToast('Failed to sign in');
            console.error(error);
        }
    });

    document.getElementById('btn-logout')?.addEventListener('click', async () => {
        try {
            await signOut();
            showToast('Signed out');
            // Clear project state
            state.projectId = null;
            state.projects = [];
            state.versions = [];
            window.history.replaceState({}, '', window.location.pathname);
            document.getElementById('welcome-screen')?.classList.remove('hidden');
        } catch (error) {
            showToast('Failed to sign out');
        }
    });

    // Update UI based on auth state
    updateAuthUI();
    events.addEventListener('auth-changed', updateAuthUI);
}

function updateAuthUI() {
    const loading = document.getElementById('auth-loading');
    const loginBtn = document.getElementById('btn-login');
    const userMenu = document.getElementById('user-menu');
    const avatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');

    if (state.isAuthLoading) {
        loading?.classList.remove('hidden');
        loginBtn?.classList.add('hidden');
        userMenu?.classList.add('hidden');
    } else if (state.user) {
        loading?.classList.add('hidden');
        loginBtn?.classList.add('hidden');
        userMenu?.classList.remove('hidden');
        if (avatar) avatar.src = state.profile?.github_avatar_url || state.user.user_metadata?.avatar_url || '';
        if (userName) userName.textContent = state.profile?.github_username || state.user.user_metadata?.user_name || 'User';
    } else {
        loading?.classList.add('hidden');
        loginBtn?.classList.remove('hidden');
        userMenu?.classList.add('hidden');
    }
}

function setupEventListeners() {
    const input = document.getElementById('prompt-input');
    const btnSend = document.getElementById('btn-send');
    
    // Input Auto-resize
    input?.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        btnSend.disabled = !input.value.trim() || state.isGenerating;
        btnSend.classList.toggle('opacity-50', btnSend.disabled);
    });

    // Send Handlers
    btnSend?.addEventListener('click', () => handleSend());
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    // Suggestions
    document.querySelectorAll('.suggestion-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            input.value = btn.dataset.prompt;
            input.dispatchEvent(new Event('input'));
            handleSend();
        });
    });
    
    // Voice
    setupVoiceInput(input, document.getElementById('btn-mic'));

    // Loading State Listener
    window.addEventListener('loading-state-changed', () => {
        btnSend.disabled = !input.value.trim() || state.isGenerating;
        btnSend.classList.toggle('opacity-50', btnSend.disabled);
    });

    // Retry Listener (from Settings/PIN flow)
    events.addEventListener('retry-generation', () => {
        if (state.pendingPrompt) handleSend(true);
    });
}

async function handleSend(isRetry = false) {
    const input = document.getElementById('prompt-input');
    const prompt = isRetry ? state.pendingPrompt : input.value.trim();

    if (!prompt) return;

    // Auth Check
    if (!state.user) {
        showToast('Please sign in with GitHub first');
        return;
    }

    // Security Check (API Key)
    if (!security.isUnlocked()) {
        state.pendingPrompt = prompt;
        startPinFlow('unlock', "Unlock API Key to Generate");
        return;
    }

    if (state.isGenerating) return;

    setLoading(true, state.projectId ? "Refining project..." : "Architecting new project...");

    try {
        // Create Project if needed
        if (!state.projectId) {
            const name = prompt.split(' ').slice(0, 4).join(' ') + (prompt.split(' ').length > 4 ? '...' : '');
            const project = await createProject(name);
            await loadProject(project.id);

            // Wait a tick for state to update
            await new Promise(r => setTimeout(r, 100));
        }

        const currentFiles = getCurrentFiles();
        const result = await generateProject(prompt, currentFiles);

        if (result) {
            state.pendingPrompt = null;
            await createVersion(state.projectId, {
                prompt: prompt,
                files: result.files,
                description: result.description || "Updated project",
            });

            input.value = '';
            input.style.height = 'auto';
            showToast(`Version generated!`);
        }
    } catch (error) {
        console.error(error);
        showToast("Generation failed: " + (error.message || "Please try again."));
    } finally {
        setLoading(false);
    }
}

// --- Model Selector ---
function injectModelSelector() {
    const dropdown = document.createElement('div');
    dropdown.id = 'model-dropdown';
    dropdown.className = 'fixed z-50 hidden';
    dropdown.innerHTML = `
        <div class="bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-xl shadow-2xl w-72 max-h-80 overflow-hidden flex flex-col">
            <div class="p-2 border-b border-gray-700/50">
                <div class="flex items-center justify-between mb-2 px-2">
                    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Select Model</span>
                    <span id="credits-badge" class="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700"></span>
                </div>
                <input id="model-search" type="text" placeholder="Search models..." class="w-full bg-gray-800 text-gray-200 text-xs p-2 rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none placeholder-gray-500">
            </div>
            <div id="model-list" class="overflow-y-auto p-1 custom-scrollbar flex-1">
                <div class="text-gray-500 text-xs text-center py-4">Loading models...</div>
            </div>
        </div>
    `;
    document.body.appendChild(dropdown);
}

function setupModelSelector() {
    const btn = document.getElementById('btn-model-selector');
    const dropdown = document.getElementById('model-dropdown');
    const search = document.getElementById('model-search');

    let models = [];
    let isOpen = false;

    btn?.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (!security.isUnlocked()) {
            startPinFlow('unlock', "Unlock to select model");
            return;
        }

        isOpen = !isOpen;

        if (isOpen) {
            // Position dropdown above button
            const rect = btn.getBoundingClientRect();
            dropdown.style.left = `${Math.max(10, rect.left - 100)}px`;
            dropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;
            dropdown.classList.remove('hidden');

            // Fetch models and credits
            const list = document.getElementById('model-list');
            const badge = document.getElementById('credits-badge');
            list.innerHTML = '<div class="text-gray-500 text-xs text-center py-4"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading...</div>';

            try {
                const [fetchedModels, credits] = await Promise.all([
                    fetchModelsWithCredits(),
                    checkCredits()
                ]);

                models = fetchedModels;

                // Update credits badge
                if (credits) {
                    if (credits.isFreeTier) {
                        badge.textContent = 'Free Tier';
                        badge.className = 'text-[10px] px-2 py-0.5 rounded bg-yellow-900/30 text-yellow-400 border border-yellow-900/30';
                    } else {
                        const remaining = (credits.remaining / 100).toFixed(2);
                        badge.textContent = `$${remaining} credits`;
                        badge.className = 'text-[10px] px-2 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-900/30';
                    }
                }

                renderModelList(models);
            } catch (err) {
                list.innerHTML = '<div class="text-red-400 text-xs text-center py-4">Failed to load models</div>';
            }

            search?.focus();
        } else {
            dropdown.classList.add('hidden');
        }
    });

    // Search filter
    search?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = models.filter(m =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query)
        );
        renderModelList(filtered);
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (isOpen && !dropdown.contains(e.target) && !btn.contains(e.target)) {
            isOpen = false;
            dropdown.classList.add('hidden');
        }
    });

    // Listen for security unlock to refresh
    window.addEventListener('security-locked', () => {
        isOpen = false;
        dropdown.classList.add('hidden');
    });
}

function renderModelList(models) {
    const list = document.getElementById('model-list');
    if (!list) return;

    if (models.length === 0) {
        list.innerHTML = '<div class="text-gray-500 text-xs text-center py-4">No models found</div>';
        return;
    }

    list.innerHTML = models.map(m => {
        const isSelected = m.id === state.settings.openRouterModel;
        const isFree = m.pricing?.prompt === "0" || m.pricing?.prompt === 0 || m.id.includes(':free');

        return `
            <div class="model-item p-2 rounded-lg cursor-pointer flex justify-between items-center group transition-colors ${isSelected ? 'bg-blue-900/30 text-blue-200' : 'hover:bg-gray-800 text-gray-300'}" data-model-id="${m.id}">
                <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium truncate">${m.name}</div>
                    <div class="text-[10px] text-gray-500 truncate">${m.id}</div>
                </div>
                <div class="flex items-center gap-1 ml-2">
                    ${isFree ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-900/30">FREE</span>' : ''}
                    ${isSelected ? '<i class="fa-solid fa-check text-blue-400 text-xs"></i>' : ''}
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers
    list.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
            const modelId = item.dataset.modelId;
            state.settings.openRouterModel = modelId;
            localStorage.setItem('app_settings', JSON.stringify({
                ...JSON.parse(localStorage.getItem('app_settings') || '{}'),
                openRouterModel: modelId
            }));
            updateModelDisplay();
            document.getElementById('model-dropdown').classList.add('hidden');
            showToast(`Model: ${item.querySelector('.text-xs').textContent}`);
        });
    });
}

function updateModelDisplay() {
    const display = document.getElementById('model-display');
    if (!display) return;

    const modelId = state.settings.openRouterModel;
    // Show short name
    const shortName = modelId.split('/').pop().split('-').slice(0, 2).join(' ');
    display.textContent = shortName.charAt(0).toUpperCase() + shortName.slice(1);
}

// Boot
init();
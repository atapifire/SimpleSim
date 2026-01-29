import { state, supabase, events, initAuth, signInWithGitHub, signOut } from './state.js';
import { security } from './security.js';
import { showToast, setLoading, setupVoiceInput } from './utils.js';
import { initSettings, startPinFlow } from './settings.js';
import { initProjects, loadProject, getCurrentFiles, createProject, createVersion } from './projects.js';
import { generateProject } from './ai.js';

// --- Initialization ---
async function init() {
    // Initialize auth first
    await initAuth();

    // Inject auth UI
    injectAuthUI();

    initSettings();
    initProjects();
    setupEventListeners();

    // Resume previous project if ID exists AND user is logged in
    if (state.projectId && state.user) {
        await loadProject(state.projectId);
    }

    document.getElementById('prompt-input')?.focus();
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

// Boot
init();
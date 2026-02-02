import { state, events } from './state.js';
import { security } from './security.js';
import { showToast } from './utils.js';
import { initSecurityModal, startPinFlow as _startPinFlow, checkSessionOnLoad } from './security-modal.js';

// Re-export checkSessionOnLoad for app.js
export { checkSessionOnLoad };
import {
    storeServerKey,
    storeShareBLocally,
    hasServerKey,
    unlockSession,
    checkSessionStatus,
    isPasskeySupported,
    getApiKey,
    clearServerKey
} from './job-queue.js';
import { devLog, devError } from './thinking.js';

// --- HTML Injection ---
const SETTINGS_MODAL_HTML = `
<div id="settings-modal" class="fixed inset-0 z-[60] hidden">
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" id="settings-backdrop"></div>
    <div class="absolute bottom-0 sm:top-1/2 sm:left-1/2 sm:transform sm:-translate-x-1/2 sm:-translate-y-1/2 w-full sm:w-[500px] bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div class="p-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50">
            <h2 class="text-lg font-semibold text-white flex items-center gap-2"><i class="fa-solid fa-sliders text-blue-400"></i> Settings</h2>
            <button id="close-settings" class="text-gray-400 hover:text-white w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10"><i class="fa-solid fa-times"></i></button>
        </div>
        <div class="p-5 overflow-y-auto custom-scrollbar space-y-6 flex-1">
            <section>
                <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">AI Model (BYOK)</h3>
                <p class="text-xs text-gray-500 mb-3">Bring your own OpenRouter API key to use any supported model.</p>
                <div id="openrouter-selection-container">
                    <div id="openrouter-models-wrapper">
                        <select id="openrouter-model-select" class="w-full bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5">
                            <option value="" disabled>Select a model...</option>
                            <option value="anthropic/claude-3.5-sonnet" selected>Claude 3.5 Sonnet</option>
                            <option value="anthropic/claude-3-opus">Claude 3 Opus</option>
                            <option value="openai/gpt-4o">GPT-4o</option>
                            <option value="openai/gpt-4-turbo">GPT-4 Turbo</option>
                            <option value="google/gemini-pro-1.5">Gemini 1.5 Pro</option>
                            <option value="meta-llama/llama-3.1-70b-instruct">Llama 3.1 70B</option>
                        </select>
                        <div class="flex justify-between items-center mt-1 px-1">
                            <button type="button" id="refresh-models" class="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1"><i class="fa-solid fa-sync"></i> Refresh list</button>
                        </div>
                    </div>
                </div>
            </section>
            <section class="pt-2 border-t border-gray-800">
                <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">OpenRouter API Key</h3>
                <p class="text-xs text-gray-500 mb-3">Required for code/site generation.</p>
                <div id="key-state-none">
                    <button id="btn-add-key" class="w-full py-2 px-4 rounded-xl border border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-gray-500 hover:bg-gray-800 transition-all flex items-center justify-center gap-2 text-sm"><i class="fa-solid fa-plus"></i> Configure OpenRouter API Key</button>
                </div>
                <div id="key-state-configured" class="hidden">
                    <div class="bg-blue-900/10 border border-blue-500/30 rounded-xl p-3 mb-3">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-2 text-blue-400 text-sm font-medium"><i class="fa-solid fa-shield-halved"></i> API Key Encrypted</div>
                            <div id="key-status-indicator" class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700 flex items-center gap-1"><i class="fa-solid fa-lock text-[10px]"></i> Locked</div>
                        </div>
                        <div class="text-xs text-gray-500 font-mono bg-gray-900/50 p-2 rounded mb-3 truncate tracking-widest">or-••••••••••••••••</div>
                        <div class="flex gap-2">
                            <button id="btn-manage-key" class="flex-1 py-1.5 px-3 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors border border-gray-700">Change Key</button>
                            <button id="btn-remove-key" class="py-1.5 px-3 bg-red-900/20 hover:bg-red-900/40 text-red-400 hover:text-red-300 text-xs rounded-lg transition-colors border border-red-900/30">Remove</button>
                        </div>
                    </div>
                </div>
            </section>
            <section class="pt-2 border-t border-gray-800">
                <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Background Jobs (Zero-Knowledge)</h3>
                <p class="text-xs text-gray-500 mb-3">Enable generation to continue even after closing the browser. Your key is split and encrypted - we never see it.</p>
                <div id="server-key-state-none">
                    <button id="btn-setup-server-key" class="w-full py-2 px-4 rounded-xl border border-dashed border-purple-600/50 text-purple-400 hover:text-purple-300 hover:border-purple-500 hover:bg-purple-900/20 transition-all flex items-center justify-center gap-2 text-sm">
                        <i class="fa-solid fa-cloud-arrow-up"></i> Enable Background Jobs
                    </button>
                    <p class="text-[10px] text-gray-600 mt-2 text-center">Uses Shamir's Secret Sharing for zero-knowledge security</p>
                </div>
                <div id="server-key-state-configured" class="hidden">
                    <div class="bg-purple-900/10 border border-purple-500/30 rounded-xl p-3 mb-3">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-2 text-purple-400 text-sm font-medium">
                                <i class="fa-solid fa-shield-halved"></i> Zero-Knowledge Key
                            </div>
                            <div id="server-key-status" class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700 flex items-center gap-1">
                                <i class="fa-solid fa-lock text-[10px]"></i> Locked
                            </div>
                        </div>
                        <div class="text-xs text-gray-500 mb-2">
                            <div class="flex items-center gap-2 mb-1">
                                <i class="fa-solid fa-check text-green-500 text-[10px]"></i>
                                <span>Share A: Encrypted on server</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <i class="fa-solid fa-check text-green-500 text-[10px]"></i>
                                <span>Share B: Encrypted locally with your PIN</span>
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <button id="btn-unlock-session" class="flex-1 py-1.5 px-3 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-lg transition-colors">
                                <i class="fa-solid fa-lock-open mr-1"></i> Unlock Session
                            </button>
                            <button id="btn-remove-server-key" class="py-1.5 px-3 bg-red-900/20 hover:bg-red-900/40 text-red-400 hover:text-red-300 text-xs rounded-lg transition-colors border border-red-900/30">
                                Remove
                            </button>
                        </div>
                        <div id="session-status-indicator" class="hidden mt-2 p-2 bg-green-900/20 border border-green-700/50 rounded-lg">
                            <div class="flex items-center justify-between text-xs">
                                <span class="text-green-400 flex items-center gap-1">
                                    <i class="fa-solid fa-circle-check"></i> Session Active
                                </span>
                                <span id="session-expires-in" class="text-gray-500">Expires in 2h</span>
                            </div>
                        </div>
                    </div>
                    <label class="flex items-center justify-between cursor-pointer">
                        <div>
                            <span class="text-sm text-gray-300">Always use background queue</span>
                            <p class="text-xs text-gray-500 mt-0.5">OFF = process on-device (faster, auto-queues if you leave)</p>
                        </div>
                        <input type="checkbox" id="use-background-jobs" class="w-4 h-4 rounded bg-gray-800 border-gray-700 text-purple-600 focus:ring-purple-500" checked>
                    </label>
                </div>
            </section>
            <section class="pt-2 border-t border-gray-800">
                <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">GitHub Integration</h3>
                <p class="text-xs text-gray-500 mb-3">Auto-sync projects to GitHub repositories.</p>
                <div class="space-y-3">
                    <label class="flex items-center justify-between cursor-pointer">
                        <span class="text-sm text-gray-300">Auto-create repo for new projects</span>
                        <input type="checkbox" id="github-auto-create" class="w-4 h-4 rounded bg-gray-800 border-gray-700 text-blue-600 focus:ring-blue-500">
                    </label>
                    <label class="flex items-center justify-between cursor-pointer">
                        <span class="text-sm text-gray-300">Auto-sync versions to GitHub</span>
                        <input type="checkbox" id="github-auto-sync" class="w-4 h-4 rounded bg-gray-800 border-gray-700 text-blue-600 focus:ring-blue-500">
                    </label>
                    <div id="github-repo-info" class="hidden bg-gray-800/50 rounded-lg p-3 text-xs">
                        <div class="flex items-center gap-2 text-gray-400">
                            <i class="fa-brands fa-github"></i>
                            <span id="github-repo-name">Not linked</span>
                        </div>
                    </div>
                </div>
            </section>
            <section class="pt-2 border-t border-gray-800">
                <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">HuggingFace API Key</h3>
                <p class="text-xs text-gray-500 mb-3">Optional. For image generation, TTS, and more.</p>
                <div id="hf-key-state-none">
                    <button id="btn-add-hf-key" class="w-full py-2 px-4 rounded-xl border border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-gray-500 hover:bg-gray-800 transition-all flex items-center justify-center gap-2 text-sm"><i class="fa-solid fa-plus"></i> Configure HuggingFace API Key</button>
                </div>
                <div id="hf-key-state-configured" class="hidden">
                    <div class="bg-purple-900/10 border border-purple-500/30 rounded-xl p-3 mb-3">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-2 text-purple-400 text-sm font-medium"><i class="fa-solid fa-shield-halved"></i> HF Key Configured</div>
                            <div id="hf-key-status-indicator" class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700 flex items-center gap-1"><i class="fa-solid fa-lock text-[10px]"></i> Locked</div>
                        </div>
                        <div class="text-xs text-gray-500 font-mono bg-gray-900/50 p-2 rounded mb-3 truncate tracking-widest">hf_••••••••••••••••</div>
                        <div class="flex gap-2">
                            <button id="btn-manage-hf-key" class="flex-1 py-1.5 px-3 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors border border-gray-700">Change Key</button>
                            <button id="btn-remove-hf-key" class="py-1.5 px-3 bg-red-900/20 hover:bg-red-900/40 text-red-400 hover:text-red-300 text-xs rounded-lg transition-colors border border-red-900/30">Remove</button>
                        </div>
                    </div>
                    <div class="space-y-2">
                        <label class="text-xs text-gray-400">Image Generation Model</label>
                        <select id="hf-image-model" class="w-full bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2">
                            <option value="stabilityai/stable-diffusion-xl-base-1.0">SDXL Base</option>
                            <option value="black-forest-labs/FLUX.1-dev">FLUX.1</option>
                            <option value="runwayml/stable-diffusion-v1-5">SD 1.5</option>
                        </select>
                        <label class="text-xs text-gray-400 mt-2">TTS Model</label>
                        <select id="hf-tts-model" class="w-full bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2">
                            <option value="facebook/mms-tts-eng">MMS TTS (English)</option>
                            <option value="microsoft/speecht5_tts">SpeechT5</option>
                        </select>
                    </div>
                </div>
            </section>
        </div>
    </div>
</div>`;

// --- Logic ---
export function initSettings() {
    document.body.insertAdjacentHTML('beforeend', SETTINGS_MODAL_HTML);
    
    // Initialize PIN Modal via module
    initSecurityModal({
        saveSettings,
        updateUI,
        fetchModels
    });
    
    loadSettings();
    setupListeners();
}

function loadSettings() {
    const stored = JSON.parse(localStorage.getItem('app_settings') || '{}');
    // OpenRouter is now the only option (BYOK)
    state.settings.useOpenRouter = true;
    state.settings.openRouterModel = stored.openRouterModel || "anthropic/claude-3.5-sonnet";
    state.settings.hfImageModel = stored.hfImageModel || "stabilityai/stable-diffusion-xl-base-1.0";
    state.settings.hfTtsModel = stored.hfTtsModel || "facebook/mms-tts-eng";
    state.settings.githubAutoCreate = localStorage.getItem('github_auto_create') === 'true';
    state.settings.githubAutoSync = localStorage.getItem('github_auto_sync') === 'true';
    state.settings.useBackgroundJobs = stored.useBackgroundJobs !== false; // Default true
    state.settings.trainingOptOut = stored.trainingOptOut !== false; // Default true

    const encData = localStorage.getItem('openrouter_enc');
    state.settings.hasKey = !!encData;

    const hfEncData = localStorage.getItem('huggingface_enc');
    state.settings.hasHfKey = !!hfEncData;

    // Check for server key (Share B stored locally)
    state.settings.hasServerKey = hasServerKey();
}

function saveSettings() {
    localStorage.setItem('app_settings', JSON.stringify({
        useOpenRouter: state.settings.useOpenRouter,
        openRouterModel: state.settings.openRouterModel,
        hfImageModel: state.settings.hfImageModel,
        hfTtsModel: state.settings.hfTtsModel,
        useBackgroundJobs: state.settings.useBackgroundJobs,
        trainingOptOut: state.settings.trainingOptOut
    }));
}

function setupListeners() {
    const d = {
        btnSettings: document.getElementById('btn-settings'),
        closeSettings: document.getElementById('close-settings'),
        settingsBackdrop: document.getElementById('settings-backdrop'),
        settingsModal: document.getElementById('settings-modal'),
        openRouterModelSelect: document.getElementById('openrouter-model-select'),
        refreshModelsBtn: document.getElementById('refresh-models'),
        btnAddKey: document.getElementById('btn-add-key'),
        btnManageKey: document.getElementById('btn-manage-key'),
        btnRemoveKey: document.getElementById('btn-remove-key'),
        // HuggingFace elements
        btnAddHfKey: document.getElementById('btn-add-hf-key'),
        btnManageHfKey: document.getElementById('btn-manage-hf-key'),
        btnRemoveHfKey: document.getElementById('btn-remove-hf-key'),
        hfImageModel: document.getElementById('hf-image-model'),
        hfTtsModel: document.getElementById('hf-tts-model'),
        // Server key elements
        btnSetupServerKey: document.getElementById('btn-setup-server-key'),
        btnUnlockSession: document.getElementById('btn-unlock-session'),
        btnRemoveServerKey: document.getElementById('btn-remove-server-key'),
        useBackgroundJobs: document.getElementById('use-background-jobs'),
    };

    // Toggle
    const toggle = (show) => {
        state.settings.isOpen = show;
        d.settingsModal.classList.toggle('hidden', !show);
        if (show) updateUI();
    };
    d.btnSettings?.addEventListener('click', () => toggle(true));
    d.closeSettings?.addEventListener('click', () => toggle(false));
    d.settingsBackdrop?.addEventListener('click', () => toggle(false));

    // Model selection
    d.openRouterModelSelect?.addEventListener('change', (e) => {
        state.settings.openRouterModel = e.target.value;
        saveSettings();
    });
    d.refreshModelsBtn?.addEventListener('click', fetchModels);

    // Keys (Delegates to Security Module)
    d.btnAddKey?.addEventListener('click', () => startPinFlow('setup'));
    d.btnManageKey?.addEventListener('click', () => startPinFlow('setup'));
    d.btnRemoveKey?.addEventListener('click', () => {
        if (confirm("Remove API key?")) {
            localStorage.removeItem('openrouter_enc');
            security.lock();
            state.settings.hasKey = false;
            saveSettings();
            updateUI();
            showToast("Key removed");
        }
    });

    // HuggingFace key management
    d.btnAddHfKey?.addEventListener('click', () => startPinFlow('setup-hf'));
    d.btnManageHfKey?.addEventListener('click', () => startPinFlow('setup-hf'));
    d.btnRemoveHfKey?.addEventListener('click', () => {
        if (confirm("Remove HuggingFace API key?")) {
            localStorage.removeItem('huggingface_enc');
            state.settings.hasHfKey = false;
            saveSettings();
            updateUI();
            showToast("HuggingFace key removed");
        }
    });

    // HuggingFace model selection
    d.hfImageModel?.addEventListener('change', (e) => {
        state.settings.hfImageModel = e.target.value;
        saveSettings();
    });
    d.hfTtsModel?.addEventListener('change', (e) => {
        state.settings.hfTtsModel = e.target.value;
        saveSettings();
    });

    // GitHub settings
    const githubAutoCreate = document.getElementById('github-auto-create');
    const githubAutoSync = document.getElementById('github-auto-sync');

    githubAutoCreate?.addEventListener('change', (e) => {
        localStorage.setItem('github_auto_create', e.target.checked);
        state.settings.githubAutoCreate = e.target.checked;
    });
    githubAutoSync?.addEventListener('change', (e) => {
        localStorage.setItem('github_auto_sync', e.target.checked);
        state.settings.githubAutoSync = e.target.checked;
    });

    // Server key / Background jobs
    d.btnSetupServerKey?.addEventListener('click', () => startPinFlow('setup-server-key'));
    d.btnUnlockSession?.addEventListener('click', () => startPinFlow('unlock-session'));
    d.btnRemoveServerKey?.addEventListener('click', async () => {
        if (confirm("Remove server key? You'll need to set it up again to use background jobs.")) {
            // Use clearServerKey() which handles both device-specific and legacy storage
            // AND invalidates server-side session
            await clearServerKey();
            state.settings.hasServerKey = false;
            state.settings.useBackgroundJobs = false;
            state.sessionUnlocked = false;
            state.serverApiKey = null;
            saveSettings();
            updateUI();
            showToast("Server key removed");
        }
    });

    d.useBackgroundJobs?.addEventListener('change', (e) => {
        state.settings.useBackgroundJobs = e.target.checked;
        saveSettings();
    });

    // External Trigger
    window.addEventListener('security-locked', () => {
        updateUI();
        showToast("Session locked");
    });

    // Listen for session events (use events from state.js, not window)
    events.addEventListener('session-unlocked', updateUI);
    events.addEventListener('session-expired', updateUI);
}

export function updateUI() {
    const els = {
        openRouterContainer: document.getElementById('openrouter-selection-container'),
        openRouterModelsWrapper: document.getElementById('openrouter-models-wrapper'),
        openRouterModelSelect: document.getElementById('openrouter-model-select'),
        keyStateNone: document.getElementById('key-state-none'),
        keyStateConfigured: document.getElementById('key-state-configured'),
        keyStatusIndicator: document.getElementById('key-status-indicator'),
        // HuggingFace elements
        hfKeyStateNone: document.getElementById('hf-key-state-none'),
        hfKeyStateConfigured: document.getElementById('hf-key-state-configured'),
        hfKeyStatusIndicator: document.getElementById('hf-key-status-indicator'),
        hfImageModel: document.getElementById('hf-image-model'),
        hfTtsModel: document.getElementById('hf-tts-model'),
        // Server key elements
        serverKeyStateNone: document.getElementById('server-key-state-none'),
        serverKeyStateConfigured: document.getElementById('server-key-state-configured'),
        serverKeyStatus: document.getElementById('server-key-status'),
        sessionStatusIndicator: document.getElementById('session-status-indicator'),
        sessionExpiresIn: document.getElementById('session-expires-in'),
        useBackgroundJobs: document.getElementById('use-background-jobs'),
    };

    // OpenRouter key state
    if (state.settings.hasKey) {
        els.openRouterContainer?.classList.remove('opacity-50', 'pointer-events-none');
        els.keyStateNone?.classList.add('hidden');
        els.keyStateConfigured?.classList.remove('hidden');

        const isUnlocked = security.isUnlocked();
        if (els.keyStatusIndicator) {
            els.keyStatusIndicator.innerHTML = isUnlocked
                ? '<i class="fa-solid fa-lock-open text-[10px]"></i> Unlocked'
                : '<i class="fa-solid fa-lock text-[10px]"></i> Locked';
            els.keyStatusIndicator.className = `text-xs px-2 py-0.5 rounded border flex items-center gap-1 ${isUnlocked ? 'bg-green-900/20 text-green-400 border-green-900/30' : 'bg-gray-800 text-gray-400 border-gray-700'}`;
        }

        // Fetch models if client key is unlocked (but NOT if using server keys - that's handled below)
        if (isUnlocked && !state.settings.hasServerKey && els.openRouterModelSelect && els.openRouterModelSelect.children.length <= 7) fetchModels();
    } else {
        els.openRouterContainer?.classList.add('opacity-50', 'pointer-events-none');
        els.keyStateNone?.classList.remove('hidden');
        els.keyStateConfigured?.classList.add('hidden');
    }

    if (els.openRouterModelSelect) {
        els.openRouterModelSelect.value = state.settings.openRouterModel;
    }

    // HuggingFace key state
    if (state.settings.hasHfKey) {
        els.hfKeyStateNone?.classList.add('hidden');
        els.hfKeyStateConfigured?.classList.remove('hidden');

        const isUnlocked = security.isUnlocked();
        if (els.hfKeyStatusIndicator) {
            els.hfKeyStatusIndicator.innerHTML = isUnlocked
                ? '<i class="fa-solid fa-lock-open text-[10px]"></i> Unlocked'
                : '<i class="fa-solid fa-lock text-[10px]"></i> Locked';
            els.hfKeyStatusIndicator.className = `text-xs px-2 py-0.5 rounded border flex items-center gap-1 ${isUnlocked ? 'bg-green-900/20 text-green-400 border-green-900/30' : 'bg-gray-800 text-gray-400 border-gray-700'}`;
        }
    } else {
        els.hfKeyStateNone?.classList.remove('hidden');
        els.hfKeyStateConfigured?.classList.add('hidden');
    }

    if (els.hfImageModel) els.hfImageModel.value = state.settings.hfImageModel;
    if (els.hfTtsModel) els.hfTtsModel.value = state.settings.hfTtsModel;

    // Server key / Background jobs state
    if (state.settings.hasServerKey) {
        els.serverKeyStateNone?.classList.add('hidden');
        els.serverKeyStateConfigured?.classList.remove('hidden');

        if (els.serverKeyStatus) {
            if (state.sessionUnlocked) {
                els.serverKeyStatus.innerHTML = '<i class="fa-solid fa-lock-open text-[10px]"></i> Unlocked';
                els.serverKeyStatus.className = 'text-xs px-2 py-0.5 rounded bg-green-900/20 text-green-400 border border-green-900/30 flex items-center gap-1';
            } else {
                els.serverKeyStatus.innerHTML = '<i class="fa-solid fa-lock text-[10px]"></i> Locked';
                els.serverKeyStatus.className = 'text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700 flex items-center gap-1';
            }
        }

        if (els.sessionStatusIndicator) {
            if (state.sessionUnlocked && state.sessionExpiresAt) {
                els.sessionStatusIndicator.classList.remove('hidden');
                const remaining = Math.max(0, state.sessionExpiresAt.getTime() - Date.now());
                const minutes = Math.floor(remaining / 60000);
                const hours = Math.floor(minutes / 60);
                if (els.sessionExpiresIn) {
                    els.sessionExpiresIn.textContent = hours > 0 ? `Expires in ${hours}h ${minutes % 60}m` : `Expires in ${minutes}m`;
                }
            } else {
                els.sessionStatusIndicator.classList.add('hidden');
            }
        }

        // Fetch models if server session is unlocked
        if (state.sessionUnlocked && els.openRouterModelSelect && els.openRouterModelSelect.children.length <= 7) {
            fetchModels();
        }
    } else {
        els.serverKeyStateNone?.classList.remove('hidden');
        els.serverKeyStateConfigured?.classList.add('hidden');
    }

    if (els.useBackgroundJobs) {
        els.useBackgroundJobs.checked = state.settings.useBackgroundJobs;
    }

    // GitHub settings
    const githubAutoCreate = document.getElementById('github-auto-create');
    const githubAutoSync = document.getElementById('github-auto-sync');
    if (githubAutoCreate) githubAutoCreate.checked = state.settings.githubAutoCreate;
    if (githubAutoSync) githubAutoSync.checked = state.settings.githubAutoSync;
}

// Wrapper for Security Modal flow
export function startPinFlow(mode, customTitle) {
    _startPinFlow(mode, customTitle);
}

// tombstone: removed PIN modal HTML and logic (moved to security-modal.js)
// removed function startPinFlow() {} (replaced by wrapper)
// removed function closePinModal() {}
// removed function handlePinConfirm() {}
// removed function showPinError() {}

async function fetchModels() {
    // Get key from either server session or client-side storage
    const key = getApiKey() || security.getKey();
    if (!key) return;
    
    const btn = document.getElementById('refresh-models');
    const select = document.getElementById('openrouter-model-select');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { "Authorization": `Bearer ${key}` }
        });
        if (response.ok) {
            const data = await response.json();
            const models = data.data.sort((a,b) => a.name.localeCompare(b.name));
            select.innerHTML = '<option value="" disabled>Select a model...</option>';
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name;
                if (m.id === state.settings.openRouterModel) opt.selected = true;
                select.appendChild(opt);
            });
        }
    } catch (e) { console.error(e); } 
    finally { btn.innerHTML = originalText; }
}
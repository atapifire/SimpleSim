import { state, events } from './state.js';
import { security } from './security.js';
import { showToast, setLoading } from './utils.js';
import { storeServerKey, storeShareBLocally, unlockSession, hasServerKey } from './job-queue.js';

const PIN_MODAL_HTML = `
<div id="pin-modal" class="fixed inset-0 z-[70] hidden flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-black/80 backdrop-blur-md" id="pin-backdrop"></div>
    <div class="relative w-full max-w-sm bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-6 animate-float-in">
        <div class="text-center mb-6">
            <div class="w-12 h-12 bg-blue-900/30 text-blue-400 rounded-full flex items-center justify-center mx-auto mb-3 text-xl border border-blue-500/20"><i class="fa-solid fa-lock"></i></div>
            <h3 id="pin-title" class="text-lg font-semibold text-white">Enter Security PIN</h3>
            <p id="pin-subtitle" class="text-sm text-gray-400 mt-1">Unlock your API key to continue</p>
        </div>
        <div id="pin-setup-fields" class="space-y-4 hidden">
             <div><label class="block text-xs font-medium text-gray-500 mb-1">API Key</label><input type="password" id="input-api-key" placeholder="sk-or-..." class="w-full bg-gray-800 border border-gray-700 text-white rounded-lg p-2.5 text-sm focus:ring-blue-500 focus:border-blue-500 font-mono"></div>
            <div><label class="block text-xs font-medium text-gray-500 mb-1">Create PIN (4-8 digits)</label><input type="password" id="input-pin-setup" maxlength="8" placeholder="••••" class="w-full bg-gray-800 border border-gray-700 text-white rounded-lg p-2.5 text-center text-lg tracking-[0.5em] focus:ring-blue-500 focus:border-blue-500 font-mono placeholder-gray-600"></div>
            <div class="text-[10px] text-gray-500 leading-tight p-2 bg-gray-800/50 rounded border border-gray-700/50"><i class="fa-solid fa-info-circle mr-1"></i> Your key is encrypted locally with this PIN. We cannot recover it if you forget the PIN.</div>
        </div>
        <div id="pin-entry-fields" class="space-y-4">
            <input type="password" id="input-pin-entry" maxlength="8" placeholder="••••" class="w-full bg-gray-800 border border-gray-700 text-white rounded-lg p-3 text-center text-2xl tracking-[0.5em] focus:ring-blue-500 focus:border-blue-500 font-mono placeholder-gray-600 transition-all">
            <p id="pin-error" class="text-red-400 text-xs text-center hidden"><i class="fa-solid fa-circle-exclamation mr-1"></i> Incorrect PIN</p>
        </div>
        <div class="mt-6 flex gap-3">
            <button id="btn-cancel-pin" class="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl transition-colors text-sm">Cancel</button>
            <button id="btn-confirm-pin" class="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg shadow-blue-900/20 transition-colors text-sm font-medium">Confirm</button>
        </div>
    </div>
</div>`;

let callbacks = {
    saveSettings: () => {},
    updateUI: () => {},
    fetchModels: () => {}
};

export function initSecurityModal(providedCallbacks) {
    callbacks = { ...callbacks, ...providedCallbacks };
    document.body.insertAdjacentHTML('beforeend', PIN_MODAL_HTML);
    setupSecurityListeners();
}

function setupSecurityListeners() {
    const d = {
        pinModal: document.getElementById('pin-modal'),
        pinBackdrop: document.getElementById('pin-backdrop'),
        btnCancelPin: document.getElementById('btn-cancel-pin'),
        btnConfirmPin: document.getElementById('btn-confirm-pin'),
        inputPinEntry: document.getElementById('input-pin-entry'),
        inputPinSetup: document.getElementById('input-pin-setup'),
        inputApiKey: document.getElementById('input-api-key')
    };

    d.btnCancelPin?.addEventListener('click', closePinModal);
    d.pinBackdrop?.addEventListener('click', closePinModal);
    d.btnConfirmPin?.addEventListener('click', handlePinConfirm);
    
    [d.inputPinEntry, d.inputPinSetup, d.inputApiKey].forEach(el => 
        el?.addEventListener('keydown', e => { if(e.key === 'Enter') handlePinConfirm(); })
    );
}

export function startPinFlow(mode, customTitle) {
    state.pinFlow = mode;
    const modal = document.getElementById('pin-modal');
    modal.classList.remove('hidden');
    document.getElementById('pin-error').classList.add('hidden');

    document.getElementById('input-pin-entry').value = '';
    document.getElementById('input-pin-setup').value = '';
    document.getElementById('input-api-key').value = '';

    if (mode === 'setup') {
        document.getElementById('pin-title').textContent = "Configure OpenRouter Key";
        document.getElementById('pin-subtitle').textContent = "Set a PIN to encrypt your API key locally";
        document.getElementById('input-api-key').placeholder = "sk-or-...";
        document.getElementById('pin-setup-fields').classList.remove('hidden');
        document.getElementById('pin-entry-fields').classList.add('hidden');
        document.getElementById('input-api-key').focus();
    } else if (mode === 'setup-hf') {
        document.getElementById('pin-title').textContent = "Configure HuggingFace Key";
        document.getElementById('pin-subtitle').textContent = "Set a PIN to encrypt your HuggingFace API key";
        document.getElementById('input-api-key').placeholder = "hf_...";
        document.getElementById('pin-setup-fields').classList.remove('hidden');
        document.getElementById('pin-entry-fields').classList.add('hidden');
        document.getElementById('input-api-key').focus();
    } else if (mode === 'setup-server-key') {
        document.getElementById('pin-title').textContent = "Enable Background Jobs";
        document.getElementById('pin-subtitle').textContent = "Your key is split for zero-knowledge security";
        document.getElementById('input-api-key').placeholder = "sk-or-... (OpenRouter API Key)";
        document.getElementById('pin-setup-fields').classList.remove('hidden');
        document.getElementById('pin-entry-fields').classList.add('hidden');
        document.getElementById('input-api-key').focus();
    } else if (mode === 'unlock-session') {
        document.getElementById('pin-title').textContent = customTitle || "Unlock Session";
        document.getElementById('pin-subtitle').textContent = "Enter PIN to activate background jobs (2h session)";
        document.getElementById('pin-setup-fields').classList.add('hidden');
        document.getElementById('pin-entry-fields').classList.remove('hidden');
        document.getElementById('input-pin-entry').focus();
    } else {
        document.getElementById('pin-title').textContent = customTitle || "Enter PIN";
        document.getElementById('pin-subtitle').textContent = "Unlock your API key to continue";
        document.getElementById('pin-setup-fields').classList.add('hidden');
        document.getElementById('pin-entry-fields').classList.remove('hidden');
        document.getElementById('input-pin-entry').focus();
    }
}

function closePinModal() {
    document.getElementById('pin-modal').classList.add('hidden');
    state.pinFlow = null;
    if (state.pendingPrompt) {
        state.pendingPrompt = null;
        setLoading(false);
        window.dispatchEvent(new Event('loading-state-changed'));
    }
}

async function handlePinConfirm() {
    const errorEl = document.getElementById('pin-error');
    errorEl.classList.add('hidden');

    if (state.pinFlow === 'setup') {
        const apiKey = document.getElementById('input-api-key').value.trim();
        const pin = document.getElementById('input-pin-setup').value.trim();

        if (!apiKey.startsWith('sk-or-')) return showPinError("Invalid Key (must start with sk-or-)");
        if (pin.length < 4) return showPinError("PIN must be 4+ digits");

        try {
            const encryptedData = await security.encrypt(apiKey, pin);
            localStorage.setItem('openrouter_enc', JSON.stringify(encryptedData));
            state.settings.hasKey = true;
            state.settings.useOpenRouter = true;
            callbacks.saveSettings();
            callbacks.updateUI();
            closePinModal();
            showToast("OpenRouter key saved");
            callbacks.fetchModels();
        } catch (e) { showPinError("Encryption failed"); }

    } else if (state.pinFlow === 'setup-hf') {
        const apiKey = document.getElementById('input-api-key').value.trim();
        const pin = document.getElementById('input-pin-setup').value.trim();

        if (!apiKey.startsWith('hf_')) return showPinError("Invalid Key (must start with hf_)");
        if (pin.length < 4) return showPinError("PIN must be 4+ digits");

        try {
            const encryptedData = await security.encrypt(apiKey, pin);
            localStorage.setItem('huggingface_enc', JSON.stringify(encryptedData));
            state.settings.hasHfKey = true;
            callbacks.saveSettings();
            callbacks.updateUI();
            closePinModal();
            showToast("HuggingFace key saved");
        } catch (e) { showPinError("Encryption failed"); }

    } else if (state.pinFlow === 'setup-server-key') {
        // Server key setup with Shamir's Secret Sharing
        const apiKey = document.getElementById('input-api-key').value.trim();
        const pin = document.getElementById('input-pin-setup').value.trim();

        if (!apiKey.startsWith('sk-or-')) return showPinError("Invalid Key (must start with sk-or-)");
        if (pin.length < 8) return showPinError("PIN must be 8+ digits for server keys");

        try {
            setLoading(true, "Setting up zero-knowledge key storage...");

            // 1. Send to server - receives Share B back
            const { shareB, keyId } = await storeServerKey(apiKey, {
                trainingOptOut: state.settings.trainingOptOut
            });

            // 2. Encrypt Share B locally with PIN
            await storeShareBLocally(shareB, pin);

            state.settings.hasServerKey = true;
            callbacks.saveSettings();
            callbacks.updateUI();
            closePinModal();
            setLoading(false);
            showToast("Background jobs enabled! Your key is now sharded.");

            // Automatically unlock the session
            try {
                await unlockSession(pin);
                showToast("Session unlocked for 2 hours");
            } catch (e) {
                console.error("Auto-unlock failed:", e);
            }

        } catch (e) {
            setLoading(false);
            console.error("Server key setup failed:", e);
            showPinError(e.message || "Failed to setup server key");
        }

    } else if (state.pinFlow === 'unlock-session') {
        // Unlock session for background jobs
        const pin = document.getElementById('input-pin-entry').value.trim();

        if (!hasServerKey()) {
            return showPinError("No server key configured");
        }

        try {
            setLoading(true, "Unlocking session...");
            await unlockSession(pin);
            closePinModal();
            setLoading(false);
            callbacks.updateUI();
            showToast("Session unlocked for 2 hours");
            events.dispatchEvent(new CustomEvent('session-unlocked'));
            if (state.pendingPrompt) events.dispatchEvent(new CustomEvent('retry-generation'));
        } catch (e) {
            setLoading(false);
            console.error("Session unlock failed:", e);
            showPinError(e.message || "Failed to unlock session");
        }

    } else if (state.pinFlow === 'unlock') {
        const pin = document.getElementById('input-pin-entry').value.trim();
        const encDataStr = localStorage.getItem('openrouter_enc');
        if (!encDataStr) return closePinModal();

        try {
            const success = await security.decrypt(JSON.parse(encDataStr), pin);
            if (success) {
                // Also try to unlock HuggingFace key if it exists
                const hfEncDataStr = localStorage.getItem('huggingface_enc');
                if (hfEncDataStr) {
                    try {
                        await security.decryptHf(JSON.parse(hfEncDataStr), pin);
                    } catch (e) {
                        // HuggingFace key might have different PIN - that's ok
                    }
                }
                closePinModal();
                callbacks.updateUI();
                showToast("Unlocked");
                if (state.pendingPrompt) events.dispatchEvent(new CustomEvent('retry-generation'));
            } else {
                showPinError("Incorrect PIN");
            }
        } catch (e) { showPinError("Decryption error"); }
    }
}

function showPinError(msg) {
    const el = document.getElementById('pin-error');
    el.textContent = msg;
    el.classList.remove('hidden');
}
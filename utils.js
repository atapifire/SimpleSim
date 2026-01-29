import { state } from './state.js';

export function showToast(msg) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    
    if (!toast || !toastMsg) return;

    toastMsg.textContent = msg;
    toast.classList.remove('opacity-0', 'translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');
    
    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-4');
        toast.classList.remove('opacity-100', 'translate-y-0');
    }, 3000);
}

export function setLoading(isLoading, text) {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    state.isGenerating = isLoading;
    
    if (isLoading) {
        overlay.classList.remove('hidden');
        if (text && loadingText) loadingText.textContent = text;
    } else {
        overlay.classList.add('hidden');
    }
    
    // Dispatch event for buttons to update
    window.dispatchEvent(new Event('loading-state-changed'));
}

export function setupVoiceInput(inputEl, btnMicEl) {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => {
            btnMicEl.classList.add('mic-active');
        };

        recognition.onend = () => {
            btnMicEl.classList.remove('mic-active');
        };

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            inputEl.value += (inputEl.value ? ' ' : '') + transcript;
            inputEl.dispatchEvent(new Event('input')); // Trigger resize/validation
        };

        btnMicEl.addEventListener('click', () => {
            recognition.start();
        });
    } else {
        btnMicEl.style.display = 'none';
    }
}
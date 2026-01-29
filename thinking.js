/**
 * Thinking UI Module
 * Shows AI progress with streaming text and expandable log
 */

// Dev mode detection
const isDev = window.location.hostname.includes('-dev') ||
              window.location.hostname === 'localhost' ||
              window.location.hostname.includes('127.0.0.1');

class ThinkingUI {
    constructor() {
        this.container = null;
        this.bar = null;
        this.textEl = null;
        this.logEl = null;
        this.expandBtn = null;
        this.isExpanded = false;
        this.logs = [];
        this.currentStatus = '';
    }

    init() {
        this.container = document.getElementById('thinking-container');
        this.bar = document.getElementById('thinking-bar');
        this.textEl = document.getElementById('thinking-text');
        this.logEl = document.getElementById('thinking-log');
        this.expandBtn = document.getElementById('thinking-expand');
        this.expandedSection = document.getElementById('thinking-expanded');

        // Click to expand/collapse
        this.bar?.addEventListener('click', (e) => {
            if (e.target.closest('#thinking-expand') || e.target === this.bar) {
                this.toggleExpand();
            }
        });

        this.expandBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleExpand();
        });
    }

    show() {
        this.container?.classList.remove('hidden');
        this.logs = [];
        if (this.logEl) this.logEl.innerHTML = '';
    }

    hide() {
        this.container?.classList.add('hidden');
        this.isExpanded = false;
        this.bar?.classList.remove('expanded');
        this.expandedSection?.classList.add('hidden');
    }

    toggleExpand() {
        this.isExpanded = !this.isExpanded;
        this.bar?.classList.toggle('expanded', this.isExpanded);
        this.expandedSection?.classList.toggle('hidden', !this.isExpanded);
    }

    setStatus(status, message) {
        this.currentStatus = status;

        // Update scrolling text
        if (this.textEl) {
            this.textEl.textContent = message;
            // Reset animation
            this.textEl.style.animation = 'none';
            this.textEl.offsetHeight; // Trigger reflow
            this.textEl.style.animation = '';
        }

        // Update indicator color
        const indicator = document.getElementById('thinking-indicator');
        if (indicator) {
            indicator.className = 'w-2 h-2 rounded-full animate-pulse';
            switch (status) {
                case 'thinking': indicator.classList.add('bg-blue-500'); break;
                case 'generating': indicator.classList.add('bg-purple-500'); break;
                case 'parsing': indicator.classList.add('bg-green-500'); break;
                case 'error': indicator.classList.add('bg-red-500'); break;
                case 'complete': indicator.classList.add('bg-green-400'); break;
                default: indicator.classList.add('bg-blue-500');
            }
        }

        this.log(status, message);
    }

    log(type, message) {
        const timestamp = new Date().toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        const entry = { type, message, timestamp };
        this.logs.push(entry);

        // Add to log UI
        if (this.logEl) {
            const div = document.createElement('div');
            div.className = `thinking-entry flex gap-2`;
            div.innerHTML = `
                <span class="text-gray-600 shrink-0">${timestamp}</span>
                <span class="status-${type}">[${type.toUpperCase()}]</span>
                <span class="text-gray-400 break-all">${this.escapeHtml(message)}</span>
            `;
            this.logEl.appendChild(div);
            this.logEl.scrollTop = this.logEl.scrollHeight;
        }

        // Console log in dev mode
        if (isDev) {
            const style = this.getConsoleStyle(type);
            console.log(`%c[${type.toUpperCase()}]%c ${message}`, style, 'color: inherit');
        }
    }

    streamText(chunk) {
        // Append chunk to scrolling text
        if (this.textEl) {
            this.textEl.textContent += chunk;
        }
    }

    getConsoleStyle(type) {
        switch (type) {
            case 'thinking': return 'color: #60a5fa; font-weight: bold';
            case 'generating': return 'color: #a78bfa; font-weight: bold';
            case 'parsing': return 'color: #34d399; font-weight: bold';
            case 'error': return 'color: #f87171; font-weight: bold';
            case 'complete': return 'color: #4ade80; font-weight: bold';
            default: return 'color: #9ca3af; font-weight: bold';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

export const thinking = new ThinkingUI();

// Debug helper for dev mode
export function devLog(...args) {
    if (isDev) {
        console.log('%c[DEV]', 'color: #f59e0b; font-weight: bold', ...args);
    }
}

export function devError(...args) {
    if (isDev) {
        console.error('%c[DEV ERROR]', 'color: #ef4444; font-weight: bold', ...args);
    }
}

export { isDev };

export class SecurityManager {
    constructor() {
        this.key = null; // In-memory decrypted OpenRouter key
        this.hfKey = null; // In-memory decrypted HuggingFace key
        this.unlockTime = 0;
        this.LOCK_TIMEOUT = 30 * 60 * 1000; // 30 minutes

        // Auto-lock on visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.checkLockTimeout();
            }
        });

        // Periodic check
        setInterval(() => this.checkLockTimeout(), 60000);
    }

    async deriveKey(pin, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        return window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt,
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async encrypt(apiKey, pin) {
        try {
            const salt = window.crypto.getRandomValues(new Uint8Array(16));
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const key = await this.deriveKey(pin, salt);
            
            const enc = new TextEncoder();
            const ciphertext = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                key,
                enc.encode(apiKey)
            );

            // Update memory immediately
            this.key = apiKey;
            this.touch();

            return {
                ciphertext: this.arrayBufferToBase64(ciphertext),
                salt: this.arrayBufferToBase64(salt),
                iv: this.arrayBufferToBase64(iv),
                iterations: 100000,
                algorithm: "AES-GCM",
                timestamp: Date.now()
            };
        } catch (e) {
            console.error("Encryption failed", e);
            throw new Error("Encryption failed");
        }
    }

    async decrypt(encryptedObj, pin) {
        if (!encryptedObj || !encryptedObj.salt || !encryptedObj.iv || !encryptedObj.ciphertext) {
            throw new Error("Invalid encrypted data");
        }

        const salt = this.base64ToArrayBuffer(encryptedObj.salt);
        const iv = this.base64ToArrayBuffer(encryptedObj.iv);
        const ciphertext = this.base64ToArrayBuffer(encryptedObj.ciphertext);
        
        try {
            const key = await this.deriveKey(pin, salt);
            const decrypted = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv },
                key,
                ciphertext
            );
            const dec = new TextDecoder();
            this.key = dec.decode(decrypted);
            this.touch();
            return true;
        } catch (e) {
            console.error("Decryption failed (likely wrong PIN)", e);
            return false;
        }
    }

    lock() {
        this.key = null;
        this.unlockTime = 0;
    }

    isUnlocked() {
        if (!this.key) return false;
        if (Date.now() - this.unlockTime > this.LOCK_TIMEOUT) {
            this.lock();
            return false;
        }
        return true;
    }

    touch() {
        if (this.key) {
            this.unlockTime = Date.now();
        }
    }

    checkLockTimeout() {
        if (this.key && Date.now() - this.unlockTime > this.LOCK_TIMEOUT) {
            this.lock();
            // Dispatch event to UI if needed
            window.dispatchEvent(new CustomEvent('security-locked'));
        }
    }

    getKey() {
        if (this.isUnlocked()) {
            this.touch();
            return this.key;
        }
        return null;
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

export const security = new SecurityManager();
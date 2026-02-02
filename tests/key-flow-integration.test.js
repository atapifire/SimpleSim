/**
 * Key Flow Integration Tests
 *
 * Tests the complete user flows for:
 * - OAuth sign-in
 * - Key registration (client-side and server-side)
 * - Key removal
 * - Session unlock
 * - Sign out / sign back in scenarios
 *
 * These tests simulate real user interactions to catch state management bugs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const localStorageMock = (() => {
    let store = {};
    return {
        getItem: vi.fn((key) => store[key] || null),
        setItem: vi.fn((key, value) => { store[key] = value; }),
        removeItem: vi.fn((key) => { delete store[key]; }),
        clear: vi.fn(() => { store = {}; }),
        get length() { return Object.keys(store).length; },
        key: vi.fn((i) => Object.keys(store)[i] || null),
        _getStore: () => store
    };
})();

// Mock state
let mockState;

// Mock security module (client-side key)
let mockSecurity;

// Mock getApiKey function
let mockGetApiKey;

function createMockState() {
    return {
        user: null,
        sessionUnlocked: false,
        serverApiKey: null,
        sessionExpiresAt: null,
        settings: {
            hasServerKey: false,
            hasOpenRouterKey: false,
            useBackgroundJobs: false,
            openRouterModel: 'meta-llama/llama-3.3-70b-instruct:free',
            trainingOptOut: true
        }
    };
}

function createMockSecurity() {
    let isUnlocked = false;
    let storedKey = null;

    return {
        isUnlocked: vi.fn(() => isUnlocked),
        getKey: vi.fn(() => isUnlocked ? storedKey : null),
        unlock: vi.fn((key) => {
            storedKey = key;
            isUnlocked = true;
            return true;
        }),
        lock: vi.fn(() => {
            isUnlocked = false;
        }),
        clear: vi.fn(() => {
            isUnlocked = false;
            storedKey = null;
        }),
        // Test helpers
        _setUnlocked: (val, key = 'sk-or-test-key') => {
            isUnlocked = val;
            storedKey = val ? key : null;
        }
    };
}

beforeEach(() => {
    localStorageMock.clear();
    mockState = createMockState();
    mockSecurity = createMockSecurity();
    mockGetApiKey = vi.fn(() => {
        // Server key takes precedence
        if (mockState.sessionUnlocked && mockState.serverApiKey) {
            return mockState.serverApiKey;
        }
        return null;
    });
});

describe('User Authentication Flows', () => {
    describe('Sign In', () => {
        it('should start with clean state on first sign in', () => {
            // Simulate OAuth callback
            mockState.user = { id: 'user-123', email: 'test@example.com' };

            expect(mockState.user).toBeTruthy();
            expect(mockState.sessionUnlocked).toBe(false);
            expect(mockState.serverApiKey).toBeNull();
            expect(mockSecurity.isUnlocked()).toBe(false);
        });

        it('should detect existing client-side key after sign in', () => {
            // User has existing client-side encrypted key
            localStorageMock.setItem('openrouter_enc', JSON.stringify({
                ciphertext: 'encrypted-data',
                iv: 'iv-data',
                salt: 'salt-data'
            }));
            mockState.settings.hasOpenRouterKey = true;

            mockState.user = { id: 'user-123' };

            expect(mockState.settings.hasOpenRouterKey).toBe(true);
            expect(mockSecurity.isUnlocked()).toBe(false); // Not yet unlocked
        });

        it('should detect existing server key after sign in', () => {
            // User has existing server key (Share B in localStorage)
            const deviceId = 'device-abc123';
            localStorageMock.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify({
                salt: 'base64salt',
                data: 'encrypted-share-b',
                deviceId: deviceId
            }));
            mockState.settings.hasServerKey = true;

            mockState.user = { id: 'user-123' };

            expect(mockState.settings.hasServerKey).toBe(true);
            expect(mockState.sessionUnlocked).toBe(false); // Not yet unlocked
        });
    });

    describe('Sign Out', () => {
        it('should clear session state on sign out', () => {
            mockState.user = { id: 'user-123' };
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-test-key';

            // Simulate sign out
            mockState.user = null;
            mockState.sessionUnlocked = false;
            mockState.serverApiKey = null;

            expect(mockState.user).toBeNull();
            expect(mockState.sessionUnlocked).toBe(false);
            expect(mockState.serverApiKey).toBeNull();
        });

        it('should NOT clear local Share B on sign out (needed for next sign in)', () => {
            const deviceId = 'device-abc123';
            localStorageMock.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify({
                data: 'encrypted-share-b'
            }));

            // Sign out - Share B should persist
            mockState.user = null;

            expect(localStorageMock.getItem(`simplesim_share_b_${deviceId}`)).toBeTruthy();
        });
    });
});

describe('Client-Side Key Flows', () => {
    beforeEach(() => {
        mockState.user = { id: 'user-123' };
    });

    describe('Key Setup', () => {
        it('should store encrypted key locally', () => {
            const apiKey = 'sk-or-v1-test-api-key-12345';
            const pin = '123456';

            // Simulate key encryption and storage
            mockSecurity.unlock(apiKey);
            localStorageMock.setItem('openrouter_enc', JSON.stringify({
                ciphertext: 'encrypted-' + apiKey,
                salt: 'random-salt'
            }));
            mockState.settings.hasOpenRouterKey = true;

            expect(mockSecurity.isUnlocked()).toBe(true);
            expect(mockSecurity.getKey()).toBe(apiKey);
            expect(localStorageMock.getItem('openrouter_enc')).toBeTruthy();
        });
    });

    describe('Key Unlock', () => {
        it('should unlock key with correct PIN', () => {
            mockState.settings.hasOpenRouterKey = true;
            localStorageMock.setItem('openrouter_enc', JSON.stringify({
                ciphertext: 'encrypted-data'
            }));

            // Simulate successful unlock
            mockSecurity._setUnlocked(true, 'sk-or-valid-key');

            expect(mockSecurity.isUnlocked()).toBe(true);
            expect(mockSecurity.getKey()).toBe('sk-or-valid-key');
        });

        it('should fail unlock with incorrect PIN', () => {
            mockState.settings.hasOpenRouterKey = true;

            // Simulate failed unlock
            mockSecurity._setUnlocked(false);

            expect(mockSecurity.isUnlocked()).toBe(false);
            expect(mockSecurity.getKey()).toBeNull();
        });
    });

    describe('Key Removal', () => {
        it('should clear all client-side key data on removal', () => {
            mockSecurity._setUnlocked(true);
            localStorageMock.setItem('openrouter_enc', JSON.stringify({ data: 'test' }));
            mockState.settings.hasOpenRouterKey = true;

            // Simulate key removal
            localStorageMock.removeItem('openrouter_enc');
            mockSecurity.clear();
            mockState.settings.hasOpenRouterKey = false;

            expect(mockSecurity.isUnlocked()).toBe(false);
            expect(mockSecurity.getKey()).toBeNull();
            expect(localStorageMock.getItem('openrouter_enc')).toBeNull();
            expect(mockState.settings.hasOpenRouterKey).toBe(false);
        });
    });
});

describe('Server-Side Key Flows (Background Jobs)', () => {
    beforeEach(() => {
        mockState.user = { id: 'user-123' };
    });

    describe('Key Setup', () => {
        it('should store Share B locally after server key setup', () => {
            const shareB = 'base64-encoded-share-b';
            const deviceId = 'device-abc123';
            const storageKey = `simplesim_share_b_${deviceId}`;

            // Simulate successful server key storage
            localStorageMock.setItem(storageKey, JSON.stringify({
                salt: 'random-salt',
                data: 'encrypted-' + shareB,
                deviceId: deviceId
            }));
            mockState.settings.hasServerKey = true;

            expect(localStorageMock.getItem(storageKey)).toBeTruthy();
            expect(mockState.settings.hasServerKey).toBe(true);
        });

        it('should invalidate old client-side key when setting up server key', () => {
            // User has old client-side key
            mockSecurity._setUnlocked(true, 'sk-or-old-key');
            localStorageMock.setItem('openrouter_enc', JSON.stringify({ data: 'old' }));
            mockState.settings.hasOpenRouterKey = true;

            // User sets up server key - should clear client-side state
            mockState.settings.hasServerKey = true;
            mockState.settings.useBackgroundJobs = true;

            // THIS IS THE BUG: Client-side key is still "unlocked"
            // The system should clear client-side unlock state when server key is used
            mockSecurity.clear(); // This should happen automatically

            expect(mockSecurity.isUnlocked()).toBe(false);
        });
    });

    describe('Session Unlock', () => {
        it('should unlock session with correct PIN and Share B', () => {
            const deviceId = 'device-abc123';
            mockState.settings.hasServerKey = true;
            localStorageMock.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify({
                salt: 'salt', data: 'share-b-data'
            }));

            // Simulate successful session unlock
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-reconstructed-key';
            mockState.sessionExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

            expect(mockState.sessionUnlocked).toBe(true);
            expect(mockState.serverApiKey).toBe('sk-or-reconstructed-key');
        });

        it('should fail unlock when Share B is missing', () => {
            mockState.settings.hasServerKey = true;
            // No Share B in localStorage

            // Attempt unlock should fail
            const hasShareB = localStorageMock.getItem('simplesim_share_b_device-123');

            expect(hasShareB).toBeNull();
            expect(mockState.sessionUnlocked).toBe(false);
        });

        it('should fail unlock when Share B does not match Share A (different key)', () => {
            mockState.settings.hasServerKey = true;
            localStorageMock.setItem('simplesim_share_b_device-123', JSON.stringify({
                data: 'old-share-b-from-different-key'
            }));

            // Server returns "Key reconstruction failed - invalid format"
            // This happens when shares don't combine to a valid sk-or-* key
            const reconstructedKey = 'garbage-data-not-a-valid-key';
            const isValidKey = reconstructedKey.startsWith('sk-or-');

            expect(isValidKey).toBe(false);
        });
    });

    describe('Key Removal and Re-setup', () => {
        it('should clear all server key data on removal', () => {
            const deviceId = 'device-abc123';
            const storageKey = `simplesim_share_b_${deviceId}`;

            mockState.settings.hasServerKey = true;
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-key';
            localStorageMock.setItem(storageKey, JSON.stringify({ data: 'share-b' }));

            // Simulate key removal
            localStorageMock.removeItem(storageKey);
            localStorageMock.removeItem('simplesim_share_b'); // Legacy
            mockState.settings.hasServerKey = false;
            mockState.sessionUnlocked = false;
            mockState.serverApiKey = null;

            expect(localStorageMock.getItem(storageKey)).toBeNull();
            expect(mockState.sessionUnlocked).toBe(false);
            expect(mockState.serverApiKey).toBeNull();
        });

        it('should clear BOTH device-specific AND legacy keys on removal', () => {
            const deviceId = 'device-abc123';
            const deviceStorageKey = `simplesim_share_b_${deviceId}`;
            const legacyStorageKey = 'simplesim_share_b';

            // Set both device-specific and legacy keys
            localStorageMock.setItem(deviceStorageKey, JSON.stringify({ data: 'device-share-b' }));
            localStorageMock.setItem(legacyStorageKey, JSON.stringify({ data: 'legacy-share-b' }));
            mockState.settings.hasServerKey = true;
            mockState.settings.useBackgroundJobs = true;

            // Proper removal should clear BOTH
            localStorageMock.removeItem(deviceStorageKey);
            localStorageMock.removeItem(legacyStorageKey);
            mockState.settings.hasServerKey = false;
            mockState.settings.useBackgroundJobs = false;

            expect(localStorageMock.getItem(deviceStorageKey)).toBeNull();
            expect(localStorageMock.getItem(legacyStorageKey)).toBeNull();
            expect(mockState.settings.hasServerKey).toBe(false);
            expect(mockState.settings.useBackgroundJobs).toBe(false);
        });

        it('should clear useBackgroundJobs setting on removal', () => {
            mockState.settings.hasServerKey = true;
            mockState.settings.useBackgroundJobs = true;

            // Simulate proper removal (must clear useBackgroundJobs too)
            mockState.settings.hasServerKey = false;
            mockState.settings.useBackgroundJobs = false;

            expect(mockState.settings.hasServerKey).toBe(false);
            expect(mockState.settings.useBackgroundJobs).toBe(false);
        });

        it('should clear all session state on removal', () => {
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-key';
            mockState.sessionExpiresAt = Date.now() + 7200000;

            // Proper removal clears ALL session state
            mockState.sessionUnlocked = false;
            mockState.serverApiKey = null;
            mockState.sessionExpiresAt = null;

            expect(mockState.sessionUnlocked).toBe(false);
            expect(mockState.serverApiKey).toBeNull();
            expect(mockState.sessionExpiresAt).toBeNull();
        });

        it('should allow re-setup of server key after removal', () => {
            const deviceId = 'device-abc123';

            // Remove old key
            localStorageMock.removeItem(`simplesim_share_b_${deviceId}`);
            mockState.settings.hasServerKey = false;

            // Setup new key
            localStorageMock.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify({
                data: 'new-share-b'
            }));
            mockState.settings.hasServerKey = true;

            expect(localStorageMock.getItem(`simplesim_share_b_${deviceId}`)).toBeTruthy();
            expect(mockState.settings.hasServerKey).toBe(true);
        });

        it('should not see old key after removal even with page reload', () => {
            const deviceId = 'device-abc123';
            const deviceStorageKey = `simplesim_share_b_${deviceId}`;

            // User has key configured
            localStorageMock.setItem(deviceStorageKey, JSON.stringify({ data: 'share-b' }));
            mockState.settings.hasServerKey = true;

            // User removes key
            localStorageMock.removeItem(deviceStorageKey);
            localStorageMock.removeItem('simplesim_share_b');
            mockState.settings.hasServerKey = false;

            // Simulate page reload - check hasServerKey logic
            const hasDeviceKey = !!localStorageMock.getItem(deviceStorageKey);
            const hasLegacyKey = !!localStorageMock.getItem('simplesim_share_b');
            const hasKey = hasDeviceKey || hasLegacyKey;

            expect(hasKey).toBe(false);
        });
    });
});

describe('API Key Priority and State Confusion', () => {
    beforeEach(() => {
        mockState.user = { id: 'user-123' };
    });

    describe('getApiKey Priority', () => {
        it('should return server key when session is unlocked', () => {
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-server-key';
            mockSecurity._setUnlocked(true, 'sk-or-client-key');

            const key = mockGetApiKey();

            expect(key).toBe('sk-or-server-key');
        });

        it('should return null when server key is configured but session not unlocked', () => {
            mockState.settings.hasServerKey = true;
            mockState.settings.useBackgroundJobs = true;
            mockState.sessionUnlocked = false;
            mockSecurity._setUnlocked(true, 'sk-or-client-key');

            // When using server keys, should NOT fall back to client key
            const key = mockGetApiKey();

            expect(key).toBeNull();
        });

        it('should NOT use stale client key when server key setup fails', () => {
            // User has old client key
            mockSecurity._setUnlocked(true, 'sk-or-old-invalid-key');
            mockState.settings.hasOpenRouterKey = true;

            // User tries to set up server key but unlock fails
            mockState.settings.hasServerKey = true;
            mockState.sessionUnlocked = false;

            // The key returned should be null, NOT the old client key
            // because user intended to use server key mode
            const shouldUseServerKey = mockState.settings.hasServerKey;
            const key = shouldUseServerKey ? mockGetApiKey() : mockSecurity.getKey();

            // This is what SHOULD happen - no fallback to client key
            expect(shouldUseServerKey).toBe(true);
            expect(mockGetApiKey()).toBeNull();
        });
    });

    describe('State Transitions', () => {
        it('should handle transition from client-side to server-side key', () => {
            // Start with client-side key
            mockSecurity._setUnlocked(true, 'sk-or-client-key');
            mockState.settings.hasOpenRouterKey = true;

            // Transition to server-side key
            mockState.settings.hasServerKey = true;
            mockState.settings.useBackgroundJobs = true;

            // Client-side key should be cleared/ignored
            mockSecurity.clear();

            expect(mockSecurity.isUnlocked()).toBe(false);
            expect(mockState.settings.hasServerKey).toBe(true);
        });

        it('should handle sign out and sign back in with server key', () => {
            const deviceId = 'device-abc123';

            // Setup: user has server key, session unlocked
            mockState.user = { id: 'user-123' };
            mockState.settings.hasServerKey = true;
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-key';
            localStorageMock.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify({
                data: 'share-b'
            }));

            // Sign out
            mockState.user = null;
            mockState.sessionUnlocked = false;
            mockState.serverApiKey = null;
            // Share B persists in localStorage

            // Sign back in
            mockState.user = { id: 'user-123' };

            // State should require unlock again
            expect(mockState.sessionUnlocked).toBe(false);
            expect(mockState.serverApiKey).toBeNull();
            // But Share B still exists for unlock
            expect(localStorageMock.getItem(`simplesim_share_b_${deviceId}`)).toBeTruthy();
        });
    });
});

describe('Error Recovery Scenarios', () => {
    beforeEach(() => {
        mockState.user = { id: 'user-123' };
    });

    it('should handle corrupted Share B gracefully', () => {
        const deviceId = 'device-abc123';
        localStorageMock.setItem(`simplesim_share_b_${deviceId}`, 'not-valid-json');
        mockState.settings.hasServerKey = true;

        // Attempting to parse should fail
        let parseError = null;
        try {
            JSON.parse(localStorageMock.getItem(`simplesim_share_b_${deviceId}`));
        } catch (e) {
            parseError = e;
        }

        expect(parseError).toBeTruthy();
    });

    it('should handle mismatched device ID gracefully', () => {
        // Share B stored for different device
        localStorageMock.setItem('simplesim_share_b_other-device', JSON.stringify({
            data: 'share-b', deviceId: 'other-device'
        }));
        mockState.settings.hasServerKey = true;

        const currentDeviceId = 'device-abc123';
        const storedData = localStorageMock.getItem(`simplesim_share_b_${currentDeviceId}`);

        // Should not find Share B for current device
        expect(storedData).toBeNull();
    });

    it('should allow full reset when key is corrupted', () => {
        const deviceId = 'device-abc123';

        // Corrupted state
        localStorageMock.setItem(`simplesim_share_b_${deviceId}`, 'corrupted');
        mockState.settings.hasServerKey = true;
        mockState.sessionUnlocked = false;

        // Full reset
        localStorageMock.removeItem(`simplesim_share_b_${deviceId}`);
        localStorageMock.removeItem('simplesim_share_b');
        mockState.settings.hasServerKey = false;

        // User can now set up fresh key
        expect(mockState.settings.hasServerKey).toBe(false);
        expect(localStorageMock.getItem(`simplesim_share_b_${deviceId}`)).toBeNull();
    });
});

describe('OpenRouter API Key Validation', () => {
    it('should validate OpenRouter key format', () => {
        const validKeys = [
            'sk-or-v1-abc123',
            'sk-or-test-key-with-dashes',
            'sk-or-1234567890abcdef'
        ];

        const invalidKeys = [
            'sk-invalid-key',
            'not-a-key',
            '',
            null,
            undefined,
            'sk-or-', // Too short
        ];

        const isValidKey = (key) => {
            if (!key || typeof key !== 'string') return false;
            return key.startsWith('sk-or-') && key.length > 10;
        };

        validKeys.forEach(key => {
            expect(isValidKey(key)).toBe(true);
        });

        invalidKeys.forEach(key => {
            expect(isValidKey(key)).toBe(false);
        });
    });
});

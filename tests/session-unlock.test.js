import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for session unlock flow
 *
 * These tests verify the critical paths in the session unlock flow:
 * 1. getApiKey() returns correct values based on state
 * 2. State consistency between unlock and model fetching
 * 3. Error handling when unlock fails
 */

// Mock state module - simulates the shared singleton
const createMockState = () => ({
    user: { id: 'test-user-123' },
    session: { access_token: 'mock-jwt-token' },
    sessionUnlocked: false,
    serverApiKey: null,
    sessionExpiresAt: null,
    settings: {
        hasServerKey: true,
        openRouterModel: 'anthropic/claude-3.5-sonnet'
    }
});

describe('getApiKey behavior', () => {
    let mockState;
    let mockSecurity;

    beforeEach(() => {
        mockState = createMockState();
        mockSecurity = {
            isUnlocked: vi.fn().mockReturnValue(false),
            getKey: vi.fn().mockReturnValue(null)
        };
    });

    // Simulate getApiKey logic from job-queue.js
    function getApiKey(state, security) {
        // First try server key (from unlocked session)
        if (state.sessionUnlocked && state.serverApiKey) {
            return state.serverApiKey;
        }

        // Fall back to client-side key (legacy)
        try {
            if (security?.isUnlocked()) {
                return security.getKey();
            }
        } catch (e) {
            // Ignore errors
        }

        return null;
    }

    it('should return null when session not unlocked', () => {
        mockState.sessionUnlocked = false;
        mockState.serverApiKey = null;

        const key = getApiKey(mockState, mockSecurity);
        expect(key).toBeNull();
    });

    it('should return null when session unlocked but no API key', () => {
        mockState.sessionUnlocked = true;
        mockState.serverApiKey = null;

        const key = getApiKey(mockState, mockSecurity);
        expect(key).toBeNull();
    });

    it('should return API key when session unlocked AND key present', () => {
        mockState.sessionUnlocked = true;
        mockState.serverApiKey = 'sk-or-v1-test-key';

        const key = getApiKey(mockState, mockSecurity);
        expect(key).toBe('sk-or-v1-test-key');
    });

    it('should fall back to security.getKey when server session not available', () => {
        mockState.sessionUnlocked = false;
        mockState.serverApiKey = null;
        mockSecurity.isUnlocked.mockReturnValue(true);
        mockSecurity.getKey.mockReturnValue('sk-or-legacy-key');

        const key = getApiKey(mockState, mockSecurity);
        expect(key).toBe('sk-or-legacy-key');
    });

    it('should prefer server key over legacy key', () => {
        mockState.sessionUnlocked = true;
        mockState.serverApiKey = 'sk-or-v1-server-key';
        mockSecurity.isUnlocked.mockReturnValue(true);
        mockSecurity.getKey.mockReturnValue('sk-or-legacy-key');

        const key = getApiKey(mockState, mockSecurity);
        expect(key).toBe('sk-or-v1-server-key');
    });
});

describe('unlock session state transitions', () => {
    let mockState;

    beforeEach(() => {
        mockState = createMockState();
    });

    // Simulates the state updates that should happen in unlockSession()
    function simulateSuccessfulUnlock(state, apiKey) {
        state.sessionUnlocked = true;
        state.sessionExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
        if (apiKey) {
            state.serverApiKey = apiKey;
        }
    }

    it('should set all state properties on successful unlock', () => {
        simulateSuccessfulUnlock(mockState, 'sk-or-v1-test-key');

        expect(mockState.sessionUnlocked).toBe(true);
        expect(mockState.serverApiKey).toBe('sk-or-v1-test-key');
        expect(mockState.sessionExpiresAt).toBeInstanceOf(Date);
    });

    it('should detect missing API key in unlock response', () => {
        // This simulates the bug: unlock succeeds but API key is missing
        simulateSuccessfulUnlock(mockState, null);

        expect(mockState.sessionUnlocked).toBe(true);
        expect(mockState.serverApiKey).toBeNull(); // BUG: This should trigger an error!
    });

    it('should validate API key format after unlock', () => {
        const apiKey = 'sk-or-v1-test-key';
        simulateSuccessfulUnlock(mockState, apiKey);

        // Validate key format
        const isValidKey = apiKey &&
                          typeof apiKey === 'string' &&
                          apiKey.startsWith('sk-or-');

        expect(isValidKey).toBe(true);
    });

    it('should detect invalid API key format', () => {
        const invalidKeys = [
            null,
            undefined,
            '',
            'invalid-key',
            'sk-invalid', // Wrong prefix
            123, // Not a string
        ];

        for (const key of invalidKeys) {
            const isValidKey = key &&
                              typeof key === 'string' &&
                              key.startsWith('sk-or-');

            expect(isValidKey).toBeFalsy();
        }
    });
});

describe('hasApiKeyAccess check', () => {
    let mockState;
    let mockSecurity;

    beforeEach(() => {
        mockState = createMockState();
        mockSecurity = {
            isUnlocked: vi.fn().mockReturnValue(false),
        };
    });

    // Simulates hasApiKeyAccess from job-queue.js
    function hasApiKeyAccess(state, security) {
        return !!(state.sessionUnlocked && state.serverApiKey) ||
               !!(security?.isUnlocked());
    }

    it('should return false when nothing is unlocked', () => {
        mockState.sessionUnlocked = false;
        mockState.serverApiKey = null;
        mockSecurity.isUnlocked.mockReturnValue(false);

        expect(hasApiKeyAccess(mockState, mockSecurity)).toBe(false);
    });

    it('should return false when session unlocked but no key', () => {
        mockState.sessionUnlocked = true;
        mockState.serverApiKey = null;
        mockSecurity.isUnlocked.mockReturnValue(false);

        // BUG: This returns false, but user thinks they're unlocked!
        expect(hasApiKeyAccess(mockState, mockSecurity)).toBe(false);
    });

    it('should return true when server session is fully valid', () => {
        mockState.sessionUnlocked = true;
        mockState.serverApiKey = 'sk-or-v1-test-key';

        expect(hasApiKeyAccess(mockState, mockSecurity)).toBe(true);
    });

    it('should return true when legacy key is unlocked', () => {
        mockState.sessionUnlocked = false;
        mockState.serverApiKey = null;
        mockSecurity.isUnlocked.mockReturnValue(true);

        expect(hasApiKeyAccess(mockState, mockSecurity)).toBe(true);
    });
});

describe('race condition scenarios', () => {
    it('should handle rapid unlock -> fetch sequence', async () => {
        const mockState = createMockState();

        // Simulate unlock completing
        const unlockPromise = new Promise(resolve => {
            setTimeout(() => {
                mockState.sessionUnlocked = true;
                mockState.serverApiKey = 'sk-or-v1-test-key';
                resolve();
            }, 10);
        });

        // Simulate fetch starting immediately after (race condition)
        const fetchPromise = new Promise(resolve => {
            setTimeout(() => {
                // At this point, state might not be updated yet
                const key = mockState.serverApiKey;
                resolve(key);
            }, 5); // Fetch starts BEFORE unlock completes
        });

        const [, fetchedKey] = await Promise.all([unlockPromise, fetchPromise]);

        // This demonstrates the race condition - fetch gets null key
        expect(fetchedKey).toBeNull();
    });

    it('should correctly sequence unlock then fetch', async () => {
        const mockState = createMockState();

        // Correct sequence: wait for unlock, then fetch
        await new Promise(resolve => {
            mockState.sessionUnlocked = true;
            mockState.serverApiKey = 'sk-or-v1-test-key';
            resolve();
        });

        // Now fetch should get the correct key
        const key = mockState.serverApiKey;
        expect(key).toBe('sk-or-v1-test-key');
    });
});

describe('sessionNeedsUnlock behavior', () => {
    let mockState;
    let mockLocalStorage;

    beforeEach(() => {
        mockState = createMockState();
        mockLocalStorage = {};
    });

    // Simulates sessionNeedsUnlock from job-queue.js
    function sessionNeedsUnlock(state, localStorage) {
        const hasShareB = !!localStorage['simplesim_share_b'];
        const hasApiKey = !!state.serverApiKey;
        return hasShareB && !hasApiKey;
    }

    it('should return false when no Share B exists', () => {
        // User hasn't set up server key at all
        mockLocalStorage = {};
        mockState.serverApiKey = null;

        expect(sessionNeedsUnlock(mockState, mockLocalStorage)).toBe(false);
    });

    it('should return true when Share B exists but no API key', () => {
        // User has set up server key but page was refreshed
        mockLocalStorage['simplesim_share_b'] = JSON.stringify({ salt: 'abc', data: 'xyz' });
        mockState.serverApiKey = null;

        expect(sessionNeedsUnlock(mockState, mockLocalStorage)).toBe(true);
    });

    it('should return false when Share B exists AND API key present', () => {
        // Session is properly unlocked
        mockLocalStorage['simplesim_share_b'] = JSON.stringify({ salt: 'abc', data: 'xyz' });
        mockState.serverApiKey = 'sk-or-v1-test-key';

        expect(sessionNeedsUnlock(mockState, mockLocalStorage)).toBe(false);
    });
});

describe('checkSessionStatus behavior', () => {
    let mockState;
    let mockLocalStorage;

    beforeEach(() => {
        mockState = createMockState();
        mockLocalStorage = {};
    });

    // Simulates the NEW checkSessionStatus logic
    async function checkSessionStatus(state, dbSessions, localStorage) {
        const hasDbSession = dbSessions && dbSessions.length > 0;
        const hasApiKey = !!state.serverApiKey;

        if (hasDbSession) {
            state.sessionExpiresAt = new Date(dbSessions[0].expires_at);
        }

        // CRITICAL: Only mark session as unlocked if we actually have the API key
        if (hasDbSession && !hasApiKey) {
            state.sessionUnlocked = false;
            return { status: 'needs_unlock', hasDbSession, hasApiKey };
        }

        state.sessionUnlocked = hasDbSession && hasApiKey;
        return { status: state.sessionUnlocked ? 'unlocked' : 'no_session', hasDbSession, hasApiKey };
    }

    it('should return no_session when no database session exists', async () => {
        mockState.serverApiKey = null;

        const result = await checkSessionStatus(mockState, [], mockLocalStorage);

        expect(result.status).toBe('no_session');
        expect(result.hasDbSession).toBe(false);
        expect(result.hasApiKey).toBe(false);
        expect(mockState.sessionUnlocked).toBe(false);
    });

    it('should return needs_unlock when session exists but API key missing', async () => {
        // This is the key bug scenario: session in DB but API key not in memory
        mockState.serverApiKey = null;
        const dbSessions = [{ expires_at: new Date(Date.now() + 3600000).toISOString() }];

        const result = await checkSessionStatus(mockState, dbSessions, mockLocalStorage);

        expect(result.status).toBe('needs_unlock');
        expect(result.hasDbSession).toBe(true);
        expect(result.hasApiKey).toBe(false);
        expect(mockState.sessionUnlocked).toBe(false); // CRITICAL: Should be false!
    });

    it('should return unlocked when session exists AND API key present', async () => {
        mockState.serverApiKey = 'sk-or-v1-test-key';
        const dbSessions = [{ expires_at: new Date(Date.now() + 3600000).toISOString() }];

        const result = await checkSessionStatus(mockState, dbSessions, mockLocalStorage);

        expect(result.status).toBe('unlocked');
        expect(result.hasDbSession).toBe(true);
        expect(result.hasApiKey).toBe(true);
        expect(mockState.sessionUnlocked).toBe(true);
    });

    it('should set sessionExpiresAt from database', async () => {
        const expiresAt = new Date(Date.now() + 7200000);
        mockState.serverApiKey = 'sk-or-v1-test-key';
        const dbSessions = [{ expires_at: expiresAt.toISOString() }];

        await checkSessionStatus(mockState, dbSessions, mockLocalStorage);

        expect(mockState.sessionExpiresAt).toBeInstanceOf(Date);
        expect(mockState.sessionExpiresAt.getTime()).toBe(expiresAt.getTime());
    });
});

describe('page refresh scenarios', () => {
    it('should simulate page refresh correctly', () => {
        // Initial state after successful unlock
        const stateBeforeRefresh = createMockState();
        stateBeforeRefresh.sessionUnlocked = true;
        stateBeforeRefresh.serverApiKey = 'sk-or-v1-test-key';
        stateBeforeRefresh.sessionExpiresAt = new Date(Date.now() + 3600000);

        // Verify everything works before refresh
        expect(stateBeforeRefresh.sessionUnlocked).toBe(true);
        expect(stateBeforeRefresh.serverApiKey).toBe('sk-or-v1-test-key');

        // Simulate page refresh - state is reset, only localStorage persists
        const stateAfterRefresh = createMockState();
        // Note: serverApiKey is null because it was stored in memory
        stateAfterRefresh.sessionUnlocked = false; // Will be set by checkSessionStatus
        stateAfterRefresh.serverApiKey = null; // LOST on refresh!

        // This demonstrates the problem
        expect(stateAfterRefresh.serverApiKey).toBeNull();
    });

    it('should detect the bug state: sessionUnlocked true but no key', () => {
        const state = createMockState();

        // This is the BUG state that was happening
        state.sessionUnlocked = true;
        state.serverApiKey = null;

        // Check if we can detect this inconsistency
        const isInconsistent = state.sessionUnlocked && !state.serverApiKey;
        expect(isInconsistent).toBe(true);

        // In the fixed version, we should never allow this state
        // checkSessionStatus should set sessionUnlocked = false when serverApiKey is null
    });
});

describe('API key validation', () => {
    function validateApiKeyFormat(key) {
        if (!key) {
            return { valid: false, error: 'Key is null or undefined' };
        }
        if (typeof key !== 'string') {
            return { valid: false, error: `Key is not a string (got ${typeof key})` };
        }
        if (!key.startsWith('sk-or-')) {
            return { valid: false, error: `Key does not start with sk-or-` };
        }
        if (key.length < 20) {
            return { valid: false, error: `Key too short (${key.length} chars)` };
        }
        if (key.length > 200) {
            return { valid: false, error: `Key suspiciously long (${key.length} chars)` };
        }
        return { valid: true };
    }

    it('should validate correct OpenRouter key format', () => {
        const validKeys = [
            'sk-or-v1-abcdef1234567890',
            'sk-or-v1-' + 'a'.repeat(42),
        ];

        for (const key of validKeys) {
            const result = validateApiKeyFormat(key);
            expect(result.valid).toBe(true);
            expect(result.error).toBeUndefined();
        }
    });

    it('should reject null/undefined keys', () => {
        expect(validateApiKeyFormat(null).valid).toBe(false);
        expect(validateApiKeyFormat(undefined).valid).toBe(false);
        expect(validateApiKeyFormat('').valid).toBe(false);
    });

    it('should reject non-string keys', () => {
        const result = validateApiKeyFormat(12345);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not a string');
    });

    it('should reject keys with wrong prefix', () => {
        const result = validateApiKeyFormat('sk-invalid-key');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('sk-or-');
    });

    it('should reject keys that are too short', () => {
        const result = validateApiKeyFormat('sk-or-abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('too short');
    });

    it('should reject suspiciously long keys', () => {
        const result = validateApiKeyFormat('sk-or-v1-' + 'a'.repeat(300));
        expect(result.valid).toBe(false);
        expect(result.error).toContain('suspiciously long');
    });
});

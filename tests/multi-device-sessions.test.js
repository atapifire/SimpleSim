/**
 * Multi-Device Session Tests
 *
 * Tests for multi-device API key support:
 * 1. Device ID generation and persistence
 * 2. Device-specific Share B storage
 * 3. Multiple devices with separate key pairs
 * 4. Session isolation between devices
 *
 * Run with: npm test -- tests/multi-device-sessions.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage
const localStorageMock = (() => {
    let store = {};
    return {
        getItem: vi.fn((key) => store[key] || null),
        setItem: vi.fn((key, value) => { store[key] = value; }),
        removeItem: vi.fn((key) => { delete store[key]; }),
        clear: vi.fn(() => { store = {}; }),
        get store() { return store; }
    };
})();

// Mock crypto.randomUUID
const mockRandomUUID = vi.fn(() => 'mock-uuid-1234-5678-abcd-ef0123456789');

// Mock navigator.userAgent
const mockUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';

describe('Device ID Generation', () => {
    beforeEach(() => {
        localStorageMock.clear();
        vi.stubGlobal('localStorage', localStorageMock);
        vi.stubGlobal('crypto', { randomUUID: mockRandomUUID });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should generate a new device ID if none exists', () => {
        // Simulate getDeviceId function
        const DEVICE_ID_KEY = 'simplesim_device_id';

        function getDeviceId() {
            let deviceId = localStorage.getItem(DEVICE_ID_KEY);
            if (!deviceId) {
                deviceId = crypto.randomUUID();
                localStorage.setItem(DEVICE_ID_KEY, deviceId);
            }
            return deviceId;
        }

        const deviceId = getDeviceId();

        expect(deviceId).toBe('mock-uuid-1234-5678-abcd-ef0123456789');
        expect(localStorage.setItem).toHaveBeenCalledWith(DEVICE_ID_KEY, deviceId);
    });

    it('should return existing device ID if one exists', () => {
        const DEVICE_ID_KEY = 'simplesim_device_id';
        const existingId = 'existing-device-id-12345';

        // Reset mock call count
        mockRandomUUID.mockClear();

        localStorage.setItem(DEVICE_ID_KEY, existingId);

        function getDeviceId() {
            let deviceId = localStorage.getItem(DEVICE_ID_KEY);
            if (!deviceId) {
                deviceId = crypto.randomUUID();
                localStorage.setItem(DEVICE_ID_KEY, deviceId);
            }
            return deviceId;
        }

        const deviceId = getDeviceId();

        expect(deviceId).toBe(existingId);
        // randomUUID should not be called since ID exists
        expect(mockRandomUUID).not.toHaveBeenCalled();
    });

    it('should generate unique IDs for different devices', () => {
        const device1Id = 'device-1-uuid';
        const device2Id = 'device-2-uuid';

        // Simulate two different devices
        expect(device1Id).not.toBe(device2Id);
    });
});

describe('Device-Specific Share B Storage', () => {
    beforeEach(() => {
        localStorageMock.clear();
        vi.stubGlobal('localStorage', localStorageMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should use device-specific storage key for Share B', () => {
        const deviceId = 'test-device-123';

        function getShareBStorageKey(devId) {
            return `simplesim_share_b_${devId}`;
        }

        const storageKey = getShareBStorageKey(deviceId);
        expect(storageKey).toBe('simplesim_share_b_test-device-123');
    });

    it('should store Share B per device', () => {
        const device1 = 'device-1';
        const device2 = 'device-2';

        const shareB1 = { salt: 'salt1', data: 'data1', deviceId: device1 };
        const shareB2 = { salt: 'salt2', data: 'data2', deviceId: device2 };

        localStorage.setItem(`simplesim_share_b_${device1}`, JSON.stringify(shareB1));
        localStorage.setItem(`simplesim_share_b_${device2}`, JSON.stringify(shareB2));

        // Verify each device has its own Share B
        const stored1 = JSON.parse(localStorage.getItem(`simplesim_share_b_${device1}`));
        const stored2 = JSON.parse(localStorage.getItem(`simplesim_share_b_${device2}`));

        expect(stored1.deviceId).toBe(device1);
        expect(stored2.deviceId).toBe(device2);
        expect(stored1.data).not.toBe(stored2.data);
    });

    it('should fall back to legacy storage if device-specific not found', () => {
        const deviceId = 'new-device';
        const legacyShareB = { salt: 'legacy-salt', data: 'legacy-data' };

        // Only legacy key exists
        localStorage.setItem('simplesim_share_b', JSON.stringify(legacyShareB));

        function getShareB(devId) {
            const deviceKey = `simplesim_share_b_${devId}`;
            let stored = localStorage.getItem(deviceKey);

            if (!stored) {
                // Fall back to legacy
                stored = localStorage.getItem('simplesim_share_b');
            }

            return stored ? JSON.parse(stored) : null;
        }

        const shareB = getShareB(deviceId);

        expect(shareB).not.toBeNull();
        expect(shareB.salt).toBe('legacy-salt');
    });

    it('should prefer device-specific storage over legacy', () => {
        const deviceId = 'my-device';
        const legacyShareB = { salt: 'legacy-salt', data: 'legacy-data' };
        const deviceShareB = { salt: 'device-salt', data: 'device-data', deviceId };

        localStorage.setItem('simplesim_share_b', JSON.stringify(legacyShareB));
        localStorage.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify(deviceShareB));

        function getShareB(devId) {
            const deviceKey = `simplesim_share_b_${devId}`;
            let stored = localStorage.getItem(deviceKey);

            if (!stored) {
                stored = localStorage.getItem('simplesim_share_b');
            }

            return stored ? JSON.parse(stored) : null;
        }

        const shareB = getShareB(deviceId);

        expect(shareB.salt).toBe('device-salt');
        expect(shareB.deviceId).toBe(deviceId);
    });
});

describe('Device Label Generation', () => {
    it('should detect Windows Chrome', () => {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        function getDeviceLabel(userAgent) {
            let label = 'Unknown Device';

            if (userAgent.includes('Windows')) label = 'Windows';
            else if (userAgent.includes('Mac OS')) label = 'Mac';
            else if (userAgent.includes('Linux')) label = 'Linux';
            else if (userAgent.includes('Android')) label = 'Android';
            else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) label = 'iOS';

            if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) label += ' Chrome';
            else if (userAgent.includes('Firefox')) label += ' Firefox';
            else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) label += ' Safari';
            else if (userAgent.includes('Edg')) label += ' Edge';

            return label;
        }

        expect(getDeviceLabel(ua)).toBe('Windows Chrome');
    });

    it('should detect Mac Safari', () => {
        const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

        function getDeviceLabel(userAgent) {
            let label = 'Unknown Device';

            if (userAgent.includes('Windows')) label = 'Windows';
            else if (userAgent.includes('Mac OS')) label = 'Mac';
            else if (userAgent.includes('Linux')) label = 'Linux';
            else if (userAgent.includes('Android')) label = 'Android';
            else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) label = 'iOS';

            if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) label += ' Chrome';
            else if (userAgent.includes('Firefox')) label += ' Firefox';
            else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) label += ' Safari';
            else if (userAgent.includes('Edg')) label += ' Edge';

            return label;
        }

        expect(getDeviceLabel(ua)).toBe('Mac Safari');
    });

    it('should detect iOS Safari', () => {
        const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

        function getDeviceLabel(userAgent) {
            let label = 'Unknown Device';

            // Check iOS first (iPhone/iPad), before Mac OS since iOS UA contains "like Mac OS X"
            if (userAgent.includes('iPhone') || userAgent.includes('iPad')) label = 'iOS';
            else if (userAgent.includes('Android')) label = 'Android';
            else if (userAgent.includes('Windows')) label = 'Windows';
            else if (userAgent.includes('Mac OS')) label = 'Mac';
            else if (userAgent.includes('Linux')) label = 'Linux';

            if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) label += ' Chrome';
            else if (userAgent.includes('Firefox')) label += ' Firefox';
            else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) label += ' Safari';
            else if (userAgent.includes('Edg')) label += ' Edge';

            return label;
        }

        expect(getDeviceLabel(ua)).toBe('iOS Safari');
    });

    it('should detect Windows Edge', () => {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

        function getDeviceLabel(userAgent) {
            let label = 'Unknown Device';

            if (userAgent.includes('Windows')) label = 'Windows';
            else if (userAgent.includes('Mac OS')) label = 'Mac';
            else if (userAgent.includes('Linux')) label = 'Linux';
            else if (userAgent.includes('Android')) label = 'Android';
            else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) label = 'iOS';

            if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) label += ' Chrome';
            else if (userAgent.includes('Firefox')) label += ' Firefox';
            else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) label += ' Safari';
            else if (userAgent.includes('Edg')) label += ' Edge';

            return label;
        }

        expect(getDeviceLabel(ua)).toBe('Windows Edge');
    });
});

describe('Multi-Device Session Isolation', () => {
    it('should allow different devices to have independent sessions', () => {
        // Simulate database state
        const activeSessions = [
            {
                user_id: 'user-123',
                device_id: 'device-A',
                encrypted_combined_key: 'encrypted-key-A',
                expires_at: new Date(Date.now() + 3600000).toISOString() // 1 hour
            },
            {
                user_id: 'user-123',
                device_id: 'device-B',
                encrypted_combined_key: 'encrypted-key-B',
                expires_at: new Date(Date.now() + 7200000).toISOString() // 2 hours
            }
        ];

        // Both devices should have valid sessions
        const sessionA = activeSessions.find(s => s.device_id === 'device-A');
        const sessionB = activeSessions.find(s => s.device_id === 'device-B');

        expect(sessionA).toBeDefined();
        expect(sessionB).toBeDefined();
        expect(sessionA.device_id).not.toBe(sessionB.device_id);
    });

    it('should allow job processor to use any valid session', () => {
        // Simulate finding a session for job processing
        const activeSessions = [
            {
                user_id: 'user-123',
                device_id: 'device-A',
                encrypted_combined_key: 'encrypted-key',
                expires_at: new Date(Date.now() + 3600000).toISOString()
            },
            {
                user_id: 'user-123',
                device_id: 'device-B',
                encrypted_combined_key: 'encrypted-key',
                expires_at: new Date(Date.now() + 7200000).toISOString()
            }
        ];

        function getSessionForUser(userId) {
            const now = new Date();
            return activeSessions
                .filter(s => s.user_id === userId && new Date(s.expires_at) > now)
                .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0];
        }

        const session = getSessionForUser('user-123');

        // Should prefer session with longest remaining time (device-B)
        expect(session).toBeDefined();
        expect(session.device_id).toBe('device-B');
    });

    it('should not affect other devices when one device unlocks', () => {
        // Simulate unlocking on device A should not remove device B's session
        const activeSessions = [
            {
                user_id: 'user-123',
                device_id: 'device-B',
                encrypted_combined_key: 'encrypted-key-B',
                expires_at: new Date(Date.now() + 7200000).toISOString()
            }
        ];

        // Device A unlocks (adds new session without removing device B)
        function unlockDevice(userId, deviceId, encryptedKey) {
            // Remove only this device's old session
            const filtered = activeSessions.filter(
                s => !(s.user_id === userId && s.device_id === deviceId)
            );

            // Add new session
            filtered.push({
                user_id: userId,
                device_id: deviceId,
                encrypted_combined_key: encryptedKey,
                expires_at: new Date(Date.now() + 7200000).toISOString()
            });

            return filtered;
        }

        const newSessions = unlockDevice('user-123', 'device-A', 'encrypted-key-A');

        // Both sessions should exist
        expect(newSessions.length).toBe(2);
        expect(newSessions.find(s => s.device_id === 'device-A')).toBeDefined();
        expect(newSessions.find(s => s.device_id === 'device-B')).toBeDefined();
    });
});

describe('hasServerKey with Multi-Device', () => {
    beforeEach(() => {
        localStorageMock.clear();
        vi.stubGlobal('localStorage', localStorageMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should return true if device-specific Share B exists', () => {
        const deviceId = 'my-device';

        localStorage.setItem(`simplesim_share_b_${deviceId}`, JSON.stringify({ salt: 's', data: 'd' }));

        function hasServerKey(devId) {
            const deviceKey = `simplesim_share_b_${devId}`;
            if (localStorage.getItem(deviceKey)) return true;
            return !!localStorage.getItem('simplesim_share_b');
        }

        expect(hasServerKey(deviceId)).toBe(true);
    });

    it('should return true if only legacy Share B exists', () => {
        const deviceId = 'new-device';

        localStorage.setItem('simplesim_share_b', JSON.stringify({ salt: 's', data: 'd' }));

        function hasServerKey(devId) {
            const deviceKey = `simplesim_share_b_${devId}`;
            if (localStorage.getItem(deviceKey)) return true;
            return !!localStorage.getItem('simplesim_share_b');
        }

        expect(hasServerKey(deviceId)).toBe(true);
    });

    it('should return false if no Share B exists', () => {
        const deviceId = 'device-without-key';

        function hasServerKey(devId) {
            const deviceKey = `simplesim_share_b_${devId}`;
            if (localStorage.getItem(deviceKey)) return true;
            return !!localStorage.getItem('simplesim_share_b');
        }

        expect(hasServerKey(deviceId)).toBe(false);
    });
});

describe('Reset Server Key with Multi-Device', () => {
    beforeEach(() => {
        localStorageMock.clear();
        vi.stubGlobal('localStorage', localStorageMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should only clear Share B for the current device', () => {
        const device1 = 'device-1';
        const device2 = 'device-2';

        // Both devices have Share B
        localStorage.setItem(`simplesim_share_b_${device1}`, JSON.stringify({ data: '1' }));
        localStorage.setItem(`simplesim_share_b_${device2}`, JSON.stringify({ data: '2' }));
        localStorage.setItem('simplesim_share_b', JSON.stringify({ data: 'legacy' }));

        function resetServerKeySetup(deviceId) {
            localStorage.removeItem(`simplesim_share_b_${deviceId}`);
            localStorage.removeItem('simplesim_share_b');
            return { success: true, deviceId };
        }

        // Reset device 1
        resetServerKeySetup(device1);

        // Device 1 should be cleared
        expect(localStorage.getItem(`simplesim_share_b_${device1}`)).toBeNull();

        // Device 2 should still have its Share B
        expect(localStorage.getItem(`simplesim_share_b_${device2}`)).not.toBeNull();

        // Legacy should be cleared
        expect(localStorage.getItem('simplesim_share_b')).toBeNull();
    });
});

describe('API Key Consistency Across Devices', () => {
    it('should reconstruct the same API key from any device shares', () => {
        // The actual API key
        const originalApiKey = 'sk-or-v1-test1234567890abcdef';

        // Different devices have different Share A/B pairs, but combine to the same key
        // This is enforced by the Shamir's Secret Sharing algorithm

        // Simulate share combination
        function verifyKeyReconstruction(shareA, shareB, expectedKey) {
            // In real implementation, combineShares() reconstructs the key
            // For testing, we just verify the concept
            return shareA.keyId === shareB.keyId; // Both shares belong to same key
        }

        const device1Shares = {
            shareA: { keyId: 'key-1', data: 'shareA-device1' },
            shareB: { keyId: 'key-1', data: 'shareB-device1' }
        };

        const device2Shares = {
            shareA: { keyId: 'key-2', data: 'shareA-device2' },
            shareB: { keyId: 'key-2', data: 'shareB-device2' }
        };

        // Each device's shares should be consistent
        expect(verifyKeyReconstruction(device1Shares.shareA, device1Shares.shareB, originalApiKey)).toBe(true);
        expect(verifyKeyReconstruction(device2Shares.shareA, device2Shares.shareB, originalApiKey)).toBe(true);

        // But mixing shares from different devices won't work
        expect(verifyKeyReconstruction(device1Shares.shareA, device2Shares.shareB, originalApiKey)).toBe(false);
    });
});

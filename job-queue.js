/**
 * Job Queue Module
 *
 * Client-side job management with zero-knowledge security:
 * - Shamir's Secret Sharing for key sharding
 * - WebAuthn/Passkey PRF for secure unlock (with PIN fallback)
 * - Supabase Realtime for live job updates
 * - Background job submission and monitoring
 */

import { state, supabase, events } from './state.js';
import { showToast } from './utils.js';
import { devLog, devError } from './thinking.js';

// Edge Function URLs
const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
const STORE_KEY_URL = `${SUPABASE_URL}/functions/v1/store-api-key`;
const UNLOCK_SESSION_URL = `${SUPABASE_URL}/functions/v1/unlock-session`;
const AUTH_TEST_URL = `${SUPABASE_URL}/functions/v1/auth-test`;

// Device ID storage key
const DEVICE_ID_KEY = 'simplesim_device_id';

/**
 * Get or create a persistent device ID
 * This uniquely identifies this browser/device for multi-device key support
 * @returns {string} A unique device ID
 */
export function getDeviceId() {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
        // Generate a new device ID using crypto.randomUUID if available, otherwise fallback
        if (crypto.randomUUID) {
            deviceId = crypto.randomUUID();
        } else {
            // Fallback for older browsers
            deviceId = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 9);
        }
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
        devLog('Generated new device ID:', deviceId);
    }
    return deviceId;
}

/**
 * Get the storage key for Share B for this device
 * Each device has its own Share B stored separately
 */
function getShareBStorageKey() {
    const deviceId = getDeviceId();
    return `simplesim_share_b_${deviceId}`;
}

/**
 * Generate a user-friendly device label
 * Used for identifying devices in settings UI
 */
function getDeviceLabel() {
    const ua = navigator.userAgent;
    let label = 'Unknown Device';

    // Detect OS - check iOS first since iOS UA contains "like Mac OS X"
    if (ua.includes('iPhone') || ua.includes('iPad')) label = 'iOS';
    else if (ua.includes('Android')) label = 'Android';
    else if (ua.includes('Windows')) label = 'Windows';
    else if (ua.includes('Mac OS')) label = 'Mac';
    else if (ua.includes('Linux')) label = 'Linux';

    // Detect browser
    if (ua.includes('Chrome') && !ua.includes('Edg')) label += ' Chrome';
    else if (ua.includes('Firefox')) label += ' Firefox';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) label += ' Safari';
    else if (ua.includes('Edg')) label += ' Edge';

    return label;
}

// Note: Job scheduler is triggered by pg_cron (database) or GitHub Actions (backup)
// Client cannot call scheduler directly as it requires service_role key

/**
 * Get fresh access token, with timeout to prevent hanging
 * Supabase's getSession() can hang indefinitely, so we use Promise.race with timeout
 */
async function getFreshAccessToken() {
    // First check if we have a cached token that looks valid
    const cachedToken = state.session?.access_token;
    if (cachedToken) {
        try {
            const payload = JSON.parse(atob(cachedToken.split('.')[1]));
            const exp = payload.exp ? new Date(payload.exp * 1000) : null;
            const now = new Date();
            const expiresIn = exp ? Math.round((exp - now) / 1000) : 0;

            devLog('Cached token info:', {
                sub: payload.sub,
                exp: exp?.toISOString(),
                isExpired: exp ? now > exp : 'unknown',
                expiresIn: expiresIn + 's'
            });

            // If token expires in more than 5 minutes, use cached
            if (expiresIn > 300) {
                devLog('Using cached token (expires in', expiresIn + 's)');
                return cachedToken;
            }

            devLog('Cached token expiring soon, will try to refresh');
        } catch (e) {
            devLog('Could not parse cached token');
        }
    }

    // Get fresh session with timeout (getSession can hang)
    devLog('Getting fresh session...');
    try {
        const result = await Promise.race([
            supabase.auth.getSession(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Session fetch timeout (5s)')), 5000)
            )
        ]);

        const { data: { session }, error } = result;
        if (error) {
            devError('getSession error:', error.message);
        } else if (session?.access_token) {
            state.session = session;
            devLog('Got fresh session');
            return session.access_token;
        }
    } catch (e) {
        devError('Fresh session fetch failed:', e.message);
    }

    // Fall back to cached token if refresh failed
    if (cachedToken) {
        devLog('Falling back to cached token');
        return cachedToken;
    }

    devLog('No session token available');
    return null;
}

/**
 * Make an authenticated request to an Edge Function
 * Gets fresh token before request, retries once on 401
 */
async function authenticatedFetch(url, options = {}) {
    let token = await getFreshAccessToken();

    if (!token) {
        throw new Error('Not authenticated - please log in or refresh the page');
    }

    devLog('Making authenticated request to:', url);
    devLog('Token preview:', token.substring(0, 50) + '...');

    let response = await fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    });

    devLog('Response status:', response.status);

    // If we get 401, try to get the detailed error first
    if (response.status === 401) {
        // Clone and read error body BEFORE any retry attempts
        let serverError = null;
        try {
            const errorBody = await response.clone().json();
            // Handle both our format {error} and Supabase gateway format {code, message}
            serverError = errorBody.error || errorBody.message || JSON.stringify(errorBody);
            devError('Server 401 error:', serverError);
        } catch (e) {
            devError('Could not parse 401 response body:', e.message);
        }

        devLog('Got 401, forcing session refresh...');

        try {
            // Force refresh the session
            const { data: { session }, error } = await Promise.race([
                supabase.auth.refreshSession(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Refresh timeout')), 5000)
                )
            ]);

            if (error) {
                devError('refreshSession returned error:', error.message);
            }

            if (!error && session?.access_token) {
                state.session = session;
                token = session.access_token;
                devLog('Session refreshed successfully, new token preview:', token.substring(0, 50) + '...');

                // Retry the request with new token
                response = await fetch(url, {
                    ...options,
                    headers: {
                        ...options.headers,
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    }
                });

                devLog('Retry response status:', response.status);

                // Check if retry also failed
                if (response.status === 401) {
                    try {
                        const retryErrorBody = await response.clone().json();
                        serverError = retryErrorBody.error;
                        devError('Retry 401 error:', serverError);
                    } catch (e) {
                        devError('Could not parse retry 401 response:', e.message);
                    }
                }
            } else {
                devLog('Session refresh did not return valid session');
            }
        } catch (e) {
            devError('Session refresh failed:', e.message);
        }

        // If still 401, throw with detailed error
        if (response.status === 401) {
            devError('Still 401 after all attempts');
            if (serverError) {
                throw new Error(`Auth failed: ${serverError}`);
            }
            throw new Error('Session expired - please refresh the page and try again');
        }
    }

    return response;
}

/**
 * Diagnostic function to test auth - call from browser console: testAuth()
 */
export async function testAuth() {
    console.log('=== AUTH DIAGNOSTIC TEST ===');
    console.log('Timestamp:', new Date().toISOString());

    // Check state
    console.log('\n1. Client State Check:');
    console.log('   - User ID:', state.user?.id || 'NOT SET');
    console.log('   - Session object:', state.session ? 'SET' : 'NOT SET');
    console.log('   - Session access_token:', state.session?.access_token ? `SET (length: ${state.session.access_token.length})` : 'NOT SET');

    // Get fresh token
    console.log('\n2. Getting Fresh Token...');
    const token = await getFreshAccessToken();
    if (!token) {
        console.error('   FAILED: No token available');
        return { success: false, error: 'No token available' };
    }
    console.log('   Token length:', token.length);
    console.log('   Token preview:', token.substring(0, 50) + '...');

    // Decode token client-side
    console.log('\n3. Client-side Token Decode:');
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        console.log('   sub (user ID):', payload.sub);
        console.log('   aud:', payload.aud);
        console.log('   role:', payload.role);
        console.log('   iss:', payload.iss);
        const exp = new Date(payload.exp * 1000);
        const now = new Date();
        console.log('   exp:', exp.toISOString());
        console.log('   now:', now.toISOString());
        console.log('   expired:', now > exp);
        console.log('   expires in:', Math.round((exp - now) / 1000), 'seconds');
    } catch (e) {
        console.error('   Failed to decode token:', e.message);
    }

    // Call the dedicated auth-test Edge Function
    console.log('\n4. Testing Auth via Edge Function (auth-test)...');
    console.log('   URL:', AUTH_TEST_URL);

    try {
        const response = await fetch(AUTH_TEST_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ test: true })
        });

        console.log('   Response status:', response.status);

        const body = await response.text();
        console.log('   Response body (raw):', body);

        let result;
        try {
            result = JSON.parse(body);
            console.log('   Parsed response:', result);

            if (result.diagnostics) {
                console.log('\n5. Server-side Diagnostics:');
                console.log('   Environment:', result.diagnostics.envCheck);
                console.log('   Auth header received:', result.diagnostics.authHeader);
                if (result.diagnostics.tokenPayload) {
                    console.log('   Token payload (server):', result.diagnostics.tokenPayload);
                }
                if (result.diagnostics.tokenStatus) {
                    console.log('   Token status:', result.diagnostics.tokenStatus);
                }
                if (result.diagnostics.getUserAttempt) {
                    console.log('   getUser attempt:', result.diagnostics.getUserAttempt);
                }
            }

            if (result.success) {
                console.log('\n=== AUTH SUCCESS ===');
                console.log('User:', result.user);
                return { success: true, user: result.user, diagnostics: result.diagnostics };
            } else {
                console.error('\n=== AUTH FAILED ===');
                console.error('Error:', result.error);
                return { success: false, error: result.error, diagnostics: result.diagnostics };
            }
        } catch (e) {
            console.error('   Failed to parse response:', e.message);
            return { success: false, error: 'Failed to parse server response', rawBody: body };
        }
    } catch (e) {
        console.error('   Network error:', e.message);
        return { success: false, error: `Network error: ${e.message}` };
    }
}

// ============================================
// Shamir's Secret Sharing (Browser Implementation)
// ============================================

const PRIME = 257;

function mod(n, p = PRIME) {
    return ((n % p) + p) % p;
}

function modInverse(a, p = PRIME) {
    let [old_r, r] = [a, p];
    let [old_s, s] = [1, 0];
    while (r !== 0) {
        const quotient = Math.floor(old_r / r);
        [old_r, r] = [r, old_r - quotient * r];
        [old_s, s] = [s, old_s - quotient * s];
    }
    return mod(old_s, p);
}

function evaluatePolynomial(coefficients, x) {
    let result = 0;
    for (let i = coefficients.length - 1; i >= 0; i--) {
        result = mod(result * x + coefficients[i]);
    }
    return result;
}

function lagrangeInterpolate(shares) {
    let secret = 0;
    for (let i = 0; i < shares.length; i++) {
        let numerator = 1;
        let denominator = 1;
        for (let j = 0; j < shares.length; j++) {
            if (i !== j) {
                numerator = mod(numerator * (0 - shares[j].x));
                denominator = mod(denominator * (shares[i].x - shares[j].x));
            }
        }
        const lagrange = mod(numerator * modInverse(denominator));
        secret = mod(secret + shares[i].y * lagrange);
    }
    return secret;
}

/**
 * Split secret into shares (client-side, for Share B encryption)
 */
function splitSecret(secret, numShares = 2, threshold = 2) {
    const shares = Array(numShares).fill(null).map(() =>
        new Uint8Array(secret.length + 1)
    );

    for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
        const coefficients = [secret[byteIdx]];
        for (let i = 1; i < threshold; i++) {
            coefficients.push(Math.floor(Math.random() * PRIME));
        }
        for (let shareIdx = 0; shareIdx < numShares; shareIdx++) {
            const x = shareIdx + 1;
            shares[shareIdx][0] = x;
            shares[shareIdx][byteIdx + 1] = evaluatePolynomial(coefficients, x);
        }
    }
    return shares;
}

/**
 * Combine shares to reconstruct secret
 */
function combineShares(shares) {
    const secretLength = shares[0].length - 1;
    const secret = new Uint8Array(secretLength);

    for (let byteIdx = 0; byteIdx < secretLength; byteIdx++) {
        const points = shares.map(share => ({
            x: share[0],
            y: share[byteIdx + 1]
        }));
        secret[byteIdx] = lagrangeInterpolate(points);
    }
    return secret;
}

// ============================================
// Cryptographic Utilities
// ============================================

async function deriveKeyFromPIN(pin, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(pin),
        'PBKDF2',
        false,
        ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        256
    );

    return new Uint8Array(derivedBits);
}

async function encryptWithKey(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey(
        'raw', key, { name: 'AES-GCM' }, false, ['encrypt']
    );

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, cryptoKey, data
    );

    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);
    return result;
}

async function decryptWithKey(encryptedData, key) {
    const iv = encryptedData.slice(0, 12);
    const ciphertext = encryptedData.slice(12);

    const cryptoKey = await crypto.subtle.importKey(
        'raw', key, { name: 'AES-GCM' }, false, ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv }, cryptoKey, ciphertext
    );

    return new Uint8Array(decrypted);
}

function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function fromBase64(base64) {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// ============================================
// WebAuthn / Passkey Support
// ============================================

/**
 * Check if WebAuthn PRF is available
 */
export async function isPasskeySupported() {
    if (!window.PublicKeyCredential) return false;

    try {
        // Check for PRF extension support
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        return available;
    } catch {
        return false;
    }
}

/**
 * Create or retrieve passkey and derive encryption key using PRF
 */
async function getPasskeyDerivedKey(userId) {
    // PRF (Pseudo-Random Function) extension for key derivation
    // This is the "2026" way to derive keys from passkeys

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const prfSalt = new TextEncoder().encode(`simplesim-key-${userId}`);

    try {
        const credential = await navigator.credentials.get({
            publicKey: {
                challenge,
                rpId: window.location.hostname,
                userVerification: 'required',
                extensions: {
                    prf: {
                        eval: {
                            first: prfSalt
                        }
                    }
                }
            }
        });

        const prfResults = credential.getClientExtensionResults().prf;
        if (prfResults?.results?.first) {
            // Use PRF output as encryption key
            return new Uint8Array(prfResults.results.first);
        }

        throw new Error('PRF not supported on this passkey');
    } catch (error) {
        devLog('Passkey PRF not available:', error.message);
        return null;
    }
}

// ============================================
// Server Key Storage
// ============================================

/**
 * Store API key on server using sharding
 * Returns Share B for local storage
 */
export async function storeServerKey(apiKey, options = {}) {
    devLog('storeServerKey called');

    // Check if user is authenticated via state first
    if (!state.user) {
        devError('No user in state');
        throw new Error('Not authenticated');
    }

    const deviceId = getDeviceId();
    devLog('User authenticated:', state.user.id);
    devLog('Device ID:', deviceId);
    devLog('POST to:', STORE_KEY_URL);

    try {
        const response = await authenticatedFetch(STORE_KEY_URL, {
            method: 'POST',
            body: JSON.stringify({
                apiKey,
                deviceId,
                deviceLabel: options.deviceLabel || getDeviceLabel(),
                provider: options.provider || 'openrouter',
                label: options.label || 'Default Key',
                trainingOptOut: options.trainingOptOut ?? true,
                minAgeRequirement: options.minAgeRequirement || 0
            })
        });

        devLog('Response status:', response.status);

        const data = await response.json();
        devLog('Response data:', data);

        if (!response.ok) {
            devError('Server returned error:', data);
            throw new Error(data.error || `Server error: ${response.status}`);
        }

        devLog('Server key stored, received Share B');

        return {
            keyId: data.keyId,
            shareB: data.shareB // Base64 encoded
        };
    } catch (e) {
        devError('storeServerKey fetch failed:', e);
        throw e;
    }
}

/**
 * Encrypt and store Share B locally (device-specific)
 */
export async function storeShareBLocally(shareB, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKeyFromPIN(pin, salt);
    const shareBBytes = fromBase64(shareB);
    const encrypted = await encryptWithKey(shareBBytes, key);

    const stored = {
        salt: toBase64(salt),
        data: toBase64(encrypted),
        deviceId: getDeviceId(),
        createdAt: new Date().toISOString()
    };

    const storageKey = getShareBStorageKey();
    localStorage.setItem(storageKey, JSON.stringify(stored));
    devLog('Share B stored locally (PIN encrypted) for device:', getDeviceId());

    // Also update legacy key for backward compatibility (will be removed later)
    // This ensures old code paths still work during transition
    localStorage.setItem('simplesim_share_b', JSON.stringify(stored));

    return true;
}

/**
 * Retrieve and decrypt Share B (device-specific with legacy fallback)
 */
export async function retrieveShareB(pin) {
    // Try device-specific key first
    const storageKey = getShareBStorageKey();
    let stored = localStorage.getItem(storageKey);

    // Fall back to legacy key if device-specific not found
    if (!stored) {
        stored = localStorage.getItem('simplesim_share_b');
        if (stored) {
            devLog('Using legacy Share B storage (will migrate on next save)');
        }
    }

    if (!stored) {
        throw new Error('No local key share found for this device');
    }

    const { salt, data } = JSON.parse(stored);
    const key = await deriveKeyFromPIN(pin, fromBase64(salt));
    const decrypted = await decryptWithKey(fromBase64(data), key);

    return toBase64(decrypted);
}

/**
 * Unlock session - combine shares and create active session
 */
export async function unlockSession(pin, options = {}) {
    devLog('unlockSession called');

    const deviceId = getDeviceId();
    devLog('Device ID:', deviceId);

    // Get Share B from local storage first (before network calls)
    devLog('Retrieving Share B from local storage...');
    let shareB;
    try {
        shareB = await retrieveShareB(pin);
        devLog('Share B retrieved successfully');
    } catch (e) {
        devError('Failed to retrieve Share B:', e.message);
        throw new Error('Invalid PIN or corrupted key data');
    }

    // Generate device fingerprint (simple version)
    const fingerprint = await generateDeviceFingerprint();
    devLog('Device fingerprint generated');

    devLog('Calling unlock-session Edge Function...');
    const response = await authenticatedFetch(UNLOCK_SESSION_URL, {
        method: 'POST',
        body: JSON.stringify({
            shareB,
            deviceId,
            provider: options.provider || 'openrouter',
            deviceFingerprint: fingerprint,
            sessionDurationHours: options.sessionDurationHours || 2
        })
    });

    devLog('Unlock response status:', response.status);
    const data = await response.json();
    devLog('Unlock response data:', data.success ? 'success' : data);

    if (!response.ok) {
        devError('Unlock failed:', data.error);
        throw new Error(data.error || 'Failed to unlock session');
    }

    // CRITICAL: Validate that API key was returned
    if (!data.apiKey) {
        devError('Unlock succeeded but no API key in response!');
        devError('Response keys:', Object.keys(data));
        throw new Error('Session unlock failed: No API key returned from server. The server may have failed to decrypt your key shares.');
    }

    // Validate API key format (OpenRouter keys start with sk-or-)
    if (typeof data.apiKey !== 'string') {
        devError('API key is not a string:', typeof data.apiKey);
        throw new Error('Session unlock failed: Invalid API key type');
    }

    if (!data.apiKey.startsWith('sk-or-')) {
        devError('Invalid API key format returned:', data.apiKey?.substring(0, 20) + '...');
        devError('Key length:', data.apiKey.length);
        throw new Error('Session unlock failed: Invalid API key format. The key may have been corrupted during storage.');
    }

    // Additional length check - OpenRouter keys are typically 40-60 chars
    if (data.apiKey.length < 20 || data.apiKey.length > 200) {
        devError('API key has unusual length:', data.apiKey.length);
        devLog('Expected: 40-60 characters');
    }

    devLog('API key validation passed:', {
        prefix: data.apiKey.substring(0, 10) + '...',
        length: data.apiKey.length
    });

    // Store session token
    sessionStorage.setItem('simplesim_session_token', data.sessionToken);

    // Store API key in memory BEFORE setting sessionUnlocked flag
    // This ensures getApiKey() will return the correct value when event fires
    state.serverApiKey = data.apiKey;
    state.sessionExpiresAt = new Date(data.expiresAt);
    state.sessionUnlocked = true;

    devLog('API key stored in memory for session');
    devLog('Session unlocked until', data.expiresAt);
    devLog('state.sessionUnlocked =', state.sessionUnlocked);
    devLog('state.serverApiKey present =', !!state.serverApiKey);

    // Dispatch event AFTER all state is fully set
    events.dispatchEvent(new CustomEvent('session-unlocked'));

    return data;
}

/**
 * Get API key for use in API calls
 * Returns key from either:
 * 1. Server key (if session is unlocked)
 * 2. Client-side encrypted key (legacy)
 * 3. null if no key available
 */
export function getApiKey() {
    // First try server key (from unlocked session)
    if (state.sessionUnlocked && state.serverApiKey) {
        devLog('getApiKey: Using server session key');
        return state.serverApiKey;
    }

    // Log why server key wasn't used (for debugging)
    if (state.sessionUnlocked && !state.serverApiKey) {
        devError('getApiKey: Session marked as unlocked but no API key in state!');
    }

    // Fall back to client-side key (legacy)
    // Import dynamically to avoid circular dependency
    try {
        // security module stores decrypted key in memory
        const securityModule = window.SimpleSim?.security;
        if (securityModule?.isUnlocked()) {
            devLog('getApiKey: Using legacy client-side key');
            return securityModule.getKey();
        }
    } catch (e) {
        devLog('Could not get client-side key:', e.message);
    }

    devLog('getApiKey: No key available');
    return null;
}

/**
 * Check if any API key is available (either system)
 */
export function hasApiKeyAccess() {
    const hasServerKey = !!(state.sessionUnlocked && state.serverApiKey);
    const hasLegacyKey = !!(window.SimpleSim?.security?.isUnlocked());

    if (!hasServerKey && !hasLegacyKey) {
        devLog('hasApiKeyAccess: No key available',
            '(sessionUnlocked:', state.sessionUnlocked,
            ', serverApiKey:', !!state.serverApiKey,
            ', legacyUnlocked:', hasLegacyKey, ')');
    }

    return hasServerKey || hasLegacyKey;
}

/**
 * Validate API key format
 * @param {string} key - The API key to validate
 * @returns {{valid: boolean, error?: string}}
 */
export function validateApiKeyFormat(key) {
    if (!key) {
        return { valid: false, error: 'Key is null or undefined' };
    }
    if (typeof key !== 'string') {
        return { valid: false, error: `Key is not a string (got ${typeof key})` };
    }
    if (!key.startsWith('sk-or-')) {
        return { valid: false, error: `Key does not start with sk-or- (starts with: ${key.substring(0, 10)}...)` };
    }
    if (key.length < 20) {
        return { valid: false, error: `Key too short (${key.length} chars, expected 40+)` };
    }
    if (key.length > 200) {
        return { valid: false, error: `Key suspiciously long (${key.length} chars)` };
    }
    return { valid: true };
}

/**
 * Diagnostic function - call from browser console: diagnoseSession()
 * Checks the state of the session and API key configuration
 */
export async function diagnoseSession() {
    console.log('=== SESSION DIAGNOSTIC ===');
    console.log('Timestamp:', new Date().toISOString());

    // 1. Check user state
    console.log('\n1. USER STATE:');
    console.log('   User ID:', state.user?.id || 'NOT LOGGED IN');
    console.log('   Session token:', state.session?.access_token ? 'SET' : 'NOT SET');

    // 2. Check server key configuration
    console.log('\n2. SERVER KEY CONFIG:');
    const deviceId = getDeviceId();
    const storageKey = getShareBStorageKey();
    const hasDeviceShareB = !!localStorage.getItem(storageKey);
    const hasLegacyShareB = !!localStorage.getItem('simplesim_share_b');
    console.log('   Device ID:', deviceId);
    console.log('   Device label:', getDeviceLabel());
    console.log('   hasServerKey setting:', state.settings?.hasServerKey || false);
    console.log('   Device-specific Share B:', hasDeviceShareB);
    console.log('   Legacy Share B:', hasLegacyShareB);

    const shareBKey = hasDeviceShareB ? storageKey : (hasLegacyShareB ? 'simplesim_share_b' : null);
    if (shareBKey) {
        try {
            const shareData = JSON.parse(localStorage.getItem(shareBKey));
            console.log('   Share B storage key:', shareBKey);
            console.log('   Share B data keys:', Object.keys(shareData));
            console.log('   Share B salt length:', shareData.salt?.length || 'N/A');
            console.log('   Share B data length:', shareData.data?.length || 'N/A');
            console.log('   Share B created at:', shareData.createdAt || 'N/A (legacy)');
        } catch (e) {
            console.error('   Share B parse error:', e.message);
        }
    }

    // 3. Check session state
    console.log('\n3. SESSION STATE:');
    console.log('   sessionUnlocked:', state.sessionUnlocked);
    console.log('   serverApiKey present:', !!state.serverApiKey);
    console.log('   sessionExpiresAt:', state.sessionExpiresAt?.toISOString() || 'NOT SET');

    if (state.sessionExpiresAt) {
        const remaining = state.sessionExpiresAt.getTime() - Date.now();
        console.log('   Time remaining:', remaining > 0 ? `${Math.round(remaining / 60000)} minutes` : 'EXPIRED');
    }

    // 4. Validate API key if present
    if (state.serverApiKey) {
        console.log('\n4. API KEY VALIDATION:');
        const validation = validateApiKeyFormat(state.serverApiKey);
        console.log('   Valid format:', validation.valid);
        if (!validation.valid) {
            console.error('   Validation error:', validation.error);
        }
        console.log('   Key prefix:', state.serverApiKey.substring(0, 15) + '...');
        console.log('   Key length:', state.serverApiKey.length);
    }

    // 5. Check getApiKey() result
    console.log('\n5. getApiKey() CHECK:');
    const key = getApiKey();
    console.log('   Returns:', key ? `key (${key.length} chars)` : 'null');

    // 6. Check legacy key system
    console.log('\n6. LEGACY KEY SYSTEM:');
    const legacyUnlocked = window.SimpleSim?.security?.isUnlocked() || false;
    console.log('   Legacy unlocked:', legacyUnlocked);
    if (legacyUnlocked) {
        const legacyKey = window.SimpleSim?.security?.getKey();
        console.log('   Legacy key present:', !!legacyKey);
    }

    // 7. Test OpenRouter API (if key available)
    if (key) {
        console.log('\n7. OPENROUTER API TEST:');
        try {
            const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
                headers: { 'Authorization': `Bearer ${key}` }
            });
            console.log('   Status:', response.status);
            if (response.ok) {
                const data = await response.json();
                console.log('   Credits limit:', data.data?.limit);
                console.log('   Credits usage:', data.data?.usage);
                console.log('   API KEY IS VALID');
            } else {
                const errorText = await response.text();
                console.error('   API ERROR:', errorText.substring(0, 200));
            }
        } catch (e) {
            console.error('   Request failed:', e.message);
        }
    }

    console.log('\n=== END DIAGNOSTIC ===');

    return {
        user: !!state.user,
        deviceId,
        hasShareB: hasDeviceShareB || hasLegacyShareB,
        hasDeviceShareB,
        hasLegacyShareB,
        sessionUnlocked: state.sessionUnlocked,
        hasApiKey: !!state.serverApiKey,
        keyValid: state.serverApiKey ? validateApiKeyFormat(state.serverApiKey).valid : false
    };
}

// Make diagnoseSession available globally for console debugging
if (typeof window !== 'undefined') {
    window.diagnoseSession = diagnoseSession;
}

/**
 * Check if session is active
 *
 * IMPORTANT: This only checks if a session EXISTS in the database.
 * The actual API key is stored in memory (state.serverApiKey) and is lost on page refresh.
 *
 * We return TWO pieces of info:
 * - hasDbSession: Whether a valid session exists in the database
 * - hasApiKey: Whether we have the API key in memory (ready to use)
 *
 * If hasDbSession=true but hasApiKey=false, the user needs to re-enter their PIN to unlock.
 */
export async function checkSessionStatus() {
    if (!state.user) return false;

    try {
        const { data: sessions, error } = await supabase
            .from('active_sessions')
            .select('expires_at')
            .eq('user_id', state.user.id)
            .gt('expires_at', new Date().toISOString())
            .limit(1);

        // Handle errors gracefully (table might not exist yet, etc.)
        if (error) {
            devLog('Session check error (expected if table not set up):', error.message);
            state.sessionUnlocked = false;
            return false;
        }

        const hasDbSession = sessions && sessions.length > 0;
        const hasApiKey = !!state.serverApiKey;

        if (hasDbSession) {
            state.sessionExpiresAt = new Date(sessions[0].expires_at);
        }

        // CRITICAL FIX: Only mark session as unlocked if we actually have the API key
        // The database session existing doesn't mean we have the decrypted key in memory
        if (hasDbSession && !hasApiKey) {
            devLog('Session exists in DB but API key not in memory - need to re-unlock');
            state.sessionUnlocked = false;

            // Dispatch event so UI can prompt for PIN
            events.dispatchEvent(new CustomEvent('session-needs-unlock', {
                detail: {
                    expiresAt: state.sessionExpiresAt,
                    reason: 'API key not in memory (page refresh)'
                }
            }));

            return false; // Session not usable until re-unlocked
        }

        state.sessionUnlocked = hasDbSession && hasApiKey;

        devLog('Session status:', {
            hasDbSession,
            hasApiKey,
            sessionUnlocked: state.sessionUnlocked,
            expiresAt: state.sessionExpiresAt?.toISOString()
        });

        return state.sessionUnlocked;
    } catch (e) {
        devLog('Session check failed:', e.message);
        state.sessionUnlocked = false;
        return false;
    }
}

/**
 * Generate simple device fingerprint
 */
async function generateDeviceFingerprint() {
    const components = [
        navigator.userAgent,
        navigator.language,
        screen.width + 'x' + screen.height,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 'unknown'
    ];

    const data = components.join('|');
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hash));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ============================================
// Job Processing Notes
// ============================================
// Jobs are processed by:
// 1. pg_cron - Runs cleanup_expired() every minute in database (most reliable)
// 2. GitHub Actions - Calls job-scheduler Edge Function every minute (backup)
//
// The client CANNOT trigger the scheduler directly because:
// - Scheduler requires service_role key for security
// - User JWT tokens are not sufficient
//
// Instead, client just subscribes to Realtime updates to see job progress

// ============================================
// Job Submission and Management
// ============================================

/**
 * Submit a background job
 */
export async function submitJob(projectId, prompt, files, options = {}) {
    if (!state.user) {
        throw new Error('Not authenticated');
    }

    // Check session is unlocked
    const hasSession = await checkSessionStatus();
    if (!hasSession) {
        throw new Error('Session not unlocked. Please enter your PIN first.');
    }

    // Set job expiry to 2 hours from now (default DB is only 15 min)
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const jobData = {
        user_id: state.user.id,
        project_id: projectId,
        job_type: options.isAgent ? 'agent' : 'simple',
        prompt,
        current_files: files || [],
        model: state.settings.openRouterModel,
        training_opt_out: state.settings.trainingOptOut ?? true,
        max_iterations: options.maxIterations || 10,
        expires_at: expiresAt
    };

    devLog('Submitting background job:', jobData.job_type);

    const { data: job, error } = await supabase
        .from('jobs')
        .insert(jobData)
        .select()
        .single();

    if (error) {
        devError('Failed to submit job:', error);
        throw new Error('Failed to submit job: ' + error.message);
    }

    devLog('Job submitted:', job.id);

    // Remember this project as the last one with a job queued
    localStorage.setItem('last_job_project_id', projectId);

    // Update state
    state.currentJob = job;
    events.dispatchEvent(new CustomEvent('job-submitted', { detail: job }));

    // Jobs are processed by:
    // 1. Database trigger (instant) - via pg_net
    // 2. pg_cron backup (every minute)
    // 3. Client fallback (after 10 seconds) - see setupJobFallback()

    return job;
}

/**
 * Setup client-side fallback for job processing
 * If job stays in 'pending' status for more than FALLBACK_DELAY_MS,
 * the client will attempt to trigger processing directly.
 *
 * @param {string} jobId - The job ID to monitor
 * @param {Function} onStatusChange - Callback when status changes (to clear fallback)
 * @returns {Function} Cleanup function to cancel the fallback
 */
const FALLBACK_DELAY_MS = 10000; // 10 seconds

export function setupJobFallback(jobId, onStatusChange) {
    let fallbackTimer = null;
    let isProcessing = false;

    // Start fallback timer
    fallbackTimer = setTimeout(async () => {
        if (isProcessing) return;

        devLog(`Job ${jobId} still pending after ${FALLBACK_DELAY_MS/1000}s, checking status...`);

        try {
            // Check current job status
            const { data: job, error } = await supabase
                .from('jobs')
                .select('status')
                .eq('id', jobId)
                .single();

            if (error) {
                devError('Fallback status check failed:', error);
                return;
            }

            if (job.status === 'pending') {
                devLog('Job still pending, triggering manual processing...');
                isProcessing = true;

                // Call the job-scheduler Edge Function directly
                // This will pick up the pending job and process it
                const result = await triggerJobProcessing(jobId);

                if (result.success) {
                    devLog('Manual job processing triggered successfully');
                } else {
                    devError('Manual job processing failed:', result.error);
                }
            } else if (job.status === 'failed') {
                // Job already failed - fetch full job to get error message
                devLog('Job already failed, fetching error details...');
                const { data: failedJob } = await supabase
                    .from('jobs')
                    .select('error_message, processing_log')
                    .eq('id', jobId)
                    .single();

                const errorMsg = failedJob?.error_message || 'Unknown error';
                devError('Job failed:', errorMsg);

                // Notify via callback if provided
                if (onStatusChange) {
                    onStatusChange('failed');
                }

                // Dispatch a custom event so subscriptions can handle it
                events.dispatchEvent(new CustomEvent('job-failed-early', {
                    detail: {
                        jobId,
                        error: errorMsg,
                        logs: failedJob?.processing_log
                    }
                }));
            } else {
                devLog(`Job already ${job.status}, no fallback needed`);
            }
        } catch (err) {
            devError('Fallback error:', err);
        }
    }, FALLBACK_DELAY_MS);

    // Return cleanup function
    return (newStatus) => {
        if (newStatus && newStatus !== 'pending') {
            // Job started processing, clear fallback
            if (fallbackTimer) {
                devLog('Job processing started, clearing fallback timer');
                clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
        }
        // Also call the original callback if provided
        if (onStatusChange) {
            onStatusChange(newStatus);
        }
    };
}

/**
 * Manually trigger job processing via Edge Function
 * Used as a client-side fallback when server-side triggers fail
 */
async function triggerJobProcessing(jobId) {
    const PROCESS_JOB_URL = `${SUPABASE_URL}/functions/v1/process-job`;

    try {
        const response = await authenticatedFetch(PROCESS_JOB_URL, {
            method: 'POST',
            body: JSON.stringify({ jobId })
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            return {
                success: false,
                error: errorBody.error || errorBody.message || `HTTP ${response.status}`
            };
        }

        const result = await response.json();
        return { success: true, ...result };

    } catch (error) {
        devError('triggerJobProcessing error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Subscribe to job updates via Realtime
 */
export function subscribeToJob(jobId, callbacks = {}) {
    const {
        onProgress = () => {},
        onComplete = () => {},
        onError = () => {},
        onStatusChange = () => {},
        onLog = () => {}  // New: callback for processing log updates
    } = callbacks;

    devLog('Subscribing to job updates:', jobId);

    const channel = supabase
        .channel(`job:${jobId}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'jobs',
                filter: `id=eq.${jobId}`
            },
            (payload) => {
                const job = payload.new;
                // Show detailed status message if available
                const statusDetail = job.status_message || `Iteration ${job.current_iteration || 0}`;
                devLog('Job update:', job.status, statusDetail);

                onStatusChange(job.status);

                // Send processing logs if available
                if (job.processing_log && Array.isArray(job.processing_log)) {
                    onLog(job.processing_log, job.model_info);
                }

                if (job.job_type === 'agent') {
                    onProgress({
                        iteration: job.current_iteration,
                        maxIterations: job.max_iterations,
                        workingFiles: job.working_files,
                        statusMessage: job.status_message  // Include detailed status
                    });
                }

                if (job.status === 'completed') {
                    onComplete({
                        files: job.result_files,
                        description: job.result_description,
                        versionId: job.result_version_id,
                        iterations: job.current_iteration,
                        processingLog: job.processing_log,
                        modelInfo: job.model_info
                    });
                    channel.unsubscribe();
                }

                if (job.status === 'failed') {
                    onError(new Error(job.error_message || 'Job failed'), job.processing_log);
                    channel.unsubscribe();
                }
            }
        )
        .subscribe(async (status) => {
            // Once subscribed, check current job status to catch fast failures
            if (status === 'SUBSCRIBED') {
                try {
                    const { data: job } = await supabase
                        .from('jobs')
                        .select('status, status_message, error_message, processing_log, result_files, result_description, result_version_id, current_iteration, max_iterations, job_type, model_info')
                        .eq('id', jobId)
                        .single();

                    if (job) {
                        devLog('Initial job status check:', job.status);

                        // If job already completed or failed, handle immediately
                        if (job.status === 'completed') {
                            onStatusChange(job.status);
                            onComplete({
                                files: job.result_files,
                                description: job.result_description,
                                versionId: job.result_version_id,
                                iterations: job.current_iteration,
                                processingLog: job.processing_log,
                                modelInfo: job.model_info
                            });
                            channel.unsubscribe();
                        } else if (job.status === 'failed') {
                            onStatusChange(job.status);
                            onError(new Error(job.error_message || 'Job failed'), job.processing_log);
                            channel.unsubscribe();
                        } else if (job.status === 'processing') {
                            // Job is processing, update UI
                            onStatusChange(job.status);
                            if (job.processing_log) {
                                onLog(job.processing_log, job.model_info);
                            }
                        }
                    }
                } catch (err) {
                    devError('Failed to fetch initial job status:', err);
                }
            }
        });

    return () => {
        devLog('Unsubscribing from job:', jobId);
        channel.unsubscribe();
    };
}

/**
 * Cancel a pending job
 */
export async function cancelJob(jobId) {
    const { error } = await supabase
        .from('jobs')
        .update({ status: 'cancelled' })
        .eq('id', jobId)
        .eq('user_id', state.user.id)
        .in('status', ['pending', 'processing']);

    if (error) {
        throw new Error('Failed to cancel job: ' + error.message);
    }

    devLog('Job cancelled:', jobId);
    events.dispatchEvent(new CustomEvent('job-cancelled', { detail: { jobId } }));

    return true;
}

/**
 * Get pending jobs for current user
 */
export async function getPendingJobs() {
    if (!state.user) return [];

    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('user_id', state.user.id)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false });

    if (error) {
        devError('Failed to get pending jobs:', error);
        return [];
    }

    return jobs || [];
}

/**
 * Get set of project IDs that have active jobs
 */
export async function getActiveJobProjectIds() {
    if (!state.user) return new Set();

    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('project_id')
        .eq('user_id', state.user.id)
        .in('status', ['pending', 'processing']);

    if (error) {
        devError('Failed to get active job projects:', error);
        return new Set();
    }

    return new Set((jobs || []).map(j => j.project_id));
}

/**
 * Get last project ID that had a job queued
 */
export function getLastJobProjectId() {
    return localStorage.getItem('last_job_project_id');
}

/**
 * Clear last job project ID (call when job completes)
 */
export function clearLastJobProjectId() {
    localStorage.removeItem('last_job_project_id');
}

/**
 * Check for completed jobs since last visit (for a project)
 */
export async function checkCompletedJobs(projectId) {
    if (!state.user) return [];

    const lastCheck = localStorage.getItem(`last_job_check_${projectId}`);
    const since = lastCheck || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('*, result_version_id')
        .eq('project_id', projectId)
        .eq('user_id', state.user.id)
        .eq('status', 'completed')
        .gt('completed_at', since)
        .order('completed_at', { ascending: false });

    if (error) {
        devError('Failed to check completed jobs:', error);
        return [];
    }

    // Update last check time
    localStorage.setItem(`last_job_check_${projectId}`, new Date().toISOString());

    return jobs || [];
}

/**
 * Get job history for current user
 */
export async function getJobHistory(limit = 50) {
    if (!state.user) return [];

    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('id, job_type, prompt, status, created_at, completed_at, result_description, tokens_used, cost_cents')
        .eq('user_id', state.user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        devError('Failed to get job history:', error);
        return [];
    }

    return jobs || [];
}

// ============================================
// Session State Management
// ============================================

/**
 * Check if server key is configured for this device
 */
export function hasServerKey() {
    // Check device-specific key first
    const storageKey = getShareBStorageKey();
    if (localStorage.getItem(storageKey)) {
        return true;
    }
    // Fall back to legacy key
    return !!localStorage.getItem('simplesim_share_b');
}

/**
 * Clear local key share for this device
 */
export function clearServerKey() {
    const storageKey = getShareBStorageKey();
    localStorage.removeItem(storageKey);
    localStorage.removeItem('simplesim_share_b'); // Also clear legacy key
    state.sessionUnlocked = false;
    devLog('Server key cleared for device:', getDeviceId());
}

/**
 * Full reset of server key configuration for this device
 * Call this to completely clear the key setup and start fresh
 * Note: This only clears client-side data. Server-side Share A remains
 * until the user sets up a new key (which overwrites it for this device).
 */
export function resetServerKeySetup() {
    const deviceId = getDeviceId();
    devLog('Performing full server key reset for device:', deviceId);

    // Clear device-specific Share B
    const storageKey = getShareBStorageKey();
    localStorage.removeItem(storageKey);

    // Clear legacy Share B
    localStorage.removeItem('simplesim_share_b');

    // Clear session state
    sessionStorage.removeItem('simplesim_session_token');
    state.sessionUnlocked = false;
    state.serverApiKey = null;
    state.sessionExpiresAt = null;

    // Clear settings flag
    if (state.settings) {
        state.settings.hasServerKey = false;
    }

    devLog('Server key reset complete for device:', deviceId);

    return { success: true, message: 'Server key configuration cleared. Please set up your API key again.', deviceId };
}

// Make resetServerKeySetup available globally for console debugging
if (typeof window !== 'undefined') {
    window.resetServerKeySetup = resetServerKeySetup;
}

/**
 * Check if session exists but needs unlock (API key not in memory)
 * Returns true if user should be prompted to enter PIN
 */
export function sessionNeedsUnlock() {
    // Check device-specific key first, then legacy
    const storageKey = getShareBStorageKey();
    const hasShareB = !!localStorage.getItem(storageKey) || !!localStorage.getItem('simplesim_share_b');
    const hasApiKey = !!state.serverApiKey;

    // Session needs unlock if we have the local share but no API key in memory
    return hasShareB && !hasApiKey;
}

/**
 * Get session time remaining
 */
export function getSessionTimeRemaining() {
    if (!state.sessionExpiresAt) return 0;
    return Math.max(0, state.sessionExpiresAt.getTime() - Date.now());
}

/**
 * Format remaining time as string
 */
export function formatTimeRemaining(ms) {
    if (ms <= 0) return 'Expired';
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
}

// ============================================
// Initialize
// ============================================

/**
 * Initialize job queue system
 */
export async function initJobQueue() {
    devLog('Initializing job queue system');

    // Check session status on init
    await checkSessionStatus();

    // Listen for auth changes
    events.addEventListener('auth-changed', async () => {
        if (state.user) {
            await checkSessionStatus();

            // Log pending jobs count on auth change
            const pendingJobs = await getPendingJobs();
            if (pendingJobs.length > 0) {
                devLog('Found', pendingJobs.length, 'pending jobs on auth change');
                // Jobs are processed by pg_cron/GitHub Actions, not client
            }
        } else {
            state.sessionUnlocked = false;
            state.sessionExpiresAt = null;
        }
    });

    // Periodically check session status
    setInterval(async () => {
        if (state.user && state.sessionUnlocked) {
            const remaining = getSessionTimeRemaining();
            if (remaining < 5 * 60 * 1000) { // 5 minutes
                events.dispatchEvent(new CustomEvent('session-expiring', {
                    detail: { remaining }
                }));
            }
            if (remaining <= 0) {
                state.sessionUnlocked = false;
                events.dispatchEvent(new CustomEvent('session-expired'));
            }
        }
    }, 30000); // Check every 30 seconds

    // Log pending jobs count on init
    if (state.user) {
        const pendingJobs = await getPendingJobs();
        if (pendingJobs.length > 0) {
            devLog('Found', pendingJobs.length, 'pending jobs on init');
            // Jobs are processed by pg_cron (database) or GitHub Actions (backup)
        }
    }

    devLog('Job queue initialized');
}

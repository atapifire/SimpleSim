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

    devLog('User authenticated:', state.user.id);

    // Always get a fresh session to ensure token is valid
    // This prevents issues with stale tokens after logout/login
    devLog('Getting fresh session...');
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
            devError('getSession error:', error.message);
            throw new Error('Failed to get session: ' + error.message);
        }
        if (session?.access_token) {
            state.session = session;
            devLog('Got fresh session, token expires:', session.expires_at);
        } else {
            throw new Error('No valid session');
        }
    } catch (e) {
        devError('Failed to get session:', e.message);
        throw new Error('Not authenticated - please refresh the page');
    }

    const token = state.session?.access_token;
    if (!token) {
        throw new Error('Authentication failed - no token available');
    }

    devLog('Got access token, storing server key with sharding...');
    devLog('POST to:', STORE_KEY_URL);

    try {
        const response = await fetch(STORE_KEY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                apiKey,
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
 * Encrypt and store Share B locally
 */
export async function storeShareBLocally(shareB, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKeyFromPIN(pin, salt);
    const shareBBytes = fromBase64(shareB);
    const encrypted = await encryptWithKey(shareBBytes, key);

    const stored = {
        salt: toBase64(salt),
        data: toBase64(encrypted)
    };

    localStorage.setItem('simplesim_share_b', JSON.stringify(stored));
    devLog('Share B stored locally (PIN encrypted)');

    return true;
}

/**
 * Retrieve and decrypt Share B
 */
export async function retrieveShareB(pin) {
    const stored = localStorage.getItem('simplesim_share_b');
    if (!stored) {
        throw new Error('No local key share found');
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

    // Always get a fresh session to ensure token is valid
    devLog('Getting fresh session for unlock...');
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
            devError('getSession error:', error.message);
            throw new Error('Failed to get session: ' + error.message);
        }
        if (session?.access_token) {
            state.session = session;
            devLog('Got fresh session');
        } else {
            throw new Error('No valid session');
        }
    } catch (e) {
        devError('Failed to get session:', e.message);
        throw new Error('Not authenticated - please refresh the page');
    }

    const accessToken = state.session?.access_token;
    if (!accessToken) {
        devError('No access token for unlock');
        throw new Error('Not authenticated - please refresh the page');
    }

    devLog('Unlocking session with access token...');

    // Get Share B from local storage
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
    const response = await fetch(UNLOCK_SESSION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            shareB,
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

    // Store session token
    sessionStorage.setItem('simplesim_session_token', data.sessionToken);
    state.sessionUnlocked = true;
    state.sessionExpiresAt = new Date(data.expiresAt);

    // Store API key in memory for client-side use (model fetching, etc.)
    // This is more secure than localStorage - only in memory, cleared on page close
    if (data.apiKey) {
        state.serverApiKey = data.apiKey;
        devLog('API key stored in memory for session');
    }

    devLog('Session unlocked until', data.expiresAt);
    devLog('state.sessionUnlocked =', state.sessionUnlocked);
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
        return state.serverApiKey;
    }

    // Fall back to client-side key (legacy)
    // Import dynamically to avoid circular dependency
    try {
        // security module stores decrypted key in memory
        const securityModule = window.SimpleSim?.security;
        if (securityModule?.isUnlocked()) {
            return securityModule.getKey();
        }
    } catch (e) {
        devLog('Could not get client-side key:', e.message);
    }

    return null;
}

/**
 * Check if any API key is available (either system)
 */
export function hasApiKeyAccess() {
    return !!(state.sessionUnlocked && state.serverApiKey) ||
           !!(window.SimpleSim?.security?.isUnlocked());
}

/**
 * Check if session is active
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

        const session = sessions?.[0];
        const isActive = !!session;
        state.sessionUnlocked = isActive;

        if (session) {
            state.sessionExpiresAt = new Date(session.expires_at);
        }

        return isActive;
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

    // Update state
    state.currentJob = job;
    events.dispatchEvent(new CustomEvent('job-submitted', { detail: job }));

    return job;
}

/**
 * Subscribe to job updates via Realtime
 */
export function subscribeToJob(jobId, callbacks = {}) {
    const {
        onProgress = () => {},
        onComplete = () => {},
        onError = () => {},
        onStatusChange = () => {}
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
                devLog('Job update:', job.status, job.current_iteration);

                onStatusChange(job.status);

                if (job.job_type === 'agent') {
                    onProgress({
                        iteration: job.current_iteration,
                        maxIterations: job.max_iterations,
                        workingFiles: job.working_files
                    });
                }

                if (job.status === 'completed') {
                    onComplete({
                        files: job.result_files,
                        description: job.result_description,
                        versionId: job.result_version_id,
                        iterations: job.current_iteration
                    });
                    channel.unsubscribe();
                }

                if (job.status === 'failed') {
                    onError(new Error(job.error_message || 'Job failed'));
                    channel.unsubscribe();
                }
            }
        )
        .subscribe();

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
 * Check if server key is configured
 */
export function hasServerKey() {
    return !!localStorage.getItem('simplesim_share_b');
}

/**
 * Clear local key share
 */
export function clearServerKey() {
    localStorage.removeItem('simplesim_share_b');
    state.sessionUnlocked = false;
    devLog('Server key cleared');
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

    devLog('Job queue initialized');
}

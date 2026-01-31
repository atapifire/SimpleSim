/**
 * Unlock Session Edge Function
 * Version: 2026-01-31-v2
 *
 * Combines key shares to create a temporary active session:
 * 1. Receives Share B from client (encrypted with PIN/Passkey)
 * 2. Retrieves and decrypts Share A from database
 * 3. Combines shares to reconstruct the API key
 * 4. Encrypts the full key with a session-specific key
 * 5. Stores in active_sessions with 2-hour TTL
 *
 * This allows background jobs to use the key without permanent storage.
 */

import {
  combineShares,
  decryptAES,
  encryptAES,
  generateKey,
  sha256,
  toBase64,
  fromBase64,
  fromHex,
  toHex,
} from '../_shared/crypto.ts';
import {
  verifyAuthWithDetails,
  createServiceClient,
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/supabase.ts';

const SERVER_PEPPER = Deno.env.get('API_KEY_ENCRYPTION_SECRET');
const SESSION_SECRET = Deno.env.get('SESSION_ENCRYPTION_SECRET') || SERVER_PEPPER;

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const auth = await verifyAuthWithDetails(req);
  if (!auth.success) {
    console.error('[unlock-session] Auth failed:', auth.errorCode, auth.error);
    return errorResponse(`Unauthorized: ${auth.error} (${auth.errorCode})`, 401);
  }

  if (!SERVER_PEPPER || SERVER_PEPPER.length < 32) {
    console.error('Encryption secrets not configured');
    return errorResponse('Server configuration error', 500);
  }

  try {
    const body = await req.json();
    const {
      shareB, // Base64 encoded Share B from client
      provider = 'openrouter',
      deviceFingerprint,
      sessionDurationHours = 2,
    } = body;

    if (!shareB) {
      return errorResponse('Share B is required');
    }

    const serviceClient = createServiceClient();

    // Retrieve Share A from database
    const { data: keyRecord, error: keyError } = await serviceClient
      .from('api_keys')
      .select('id, encrypted_data, is_server_encrypted')
      .eq('user_id', auth.userId)
      .eq('provider', provider)
      .single();

    if (keyError || !keyRecord) {
      return errorResponse('API key not found. Please configure your key first.');
    }

    if (!keyRecord.is_server_encrypted || !keyRecord.encrypted_data) {
      return errorResponse('Key not properly configured. Please re-save your API key.');
    }

    // Decrypt Share A
    const shareAData = keyRecord.encrypted_data;
    const pepperKey = fromHex(SERVER_PEPPER!.padEnd(64, '0').slice(0, 64));

    let shareABytes: Uint8Array;
    try {
      shareABytes = await decryptAES(
        fromBase64(shareAData.ciphertext),
        fromBase64(shareAData.iv),
        fromBase64(shareAData.tag),
        pepperKey
      );
    } catch (decryptError) {
      console.error('Failed to decrypt Share A:', decryptError);
      return errorResponse('Failed to decrypt server key share');
    }

    // Combine shares
    const shareBBytes = fromBase64(shareB);
    let apiKeyBytes: Uint8Array;

    try {
      apiKeyBytes = combineShares([shareABytes, shareBBytes]);
    } catch (combineError) {
      console.error('Failed to combine shares:', combineError);
      return errorResponse('Invalid key shares - cannot reconstruct key');
    }

    // Validate reconstructed key
    const decoder = new TextDecoder();
    const apiKey = decoder.decode(apiKeyBytes);

    if (provider === 'openrouter' && !apiKey.startsWith('sk-or-')) {
      return errorResponse('Key reconstruction failed - invalid format');
    }

    // Generate session token
    const sessionToken = toHex(generateKey());
    const sessionTokenHash = toHex(await sha256(sessionToken));

    // Encrypt the full API key for session storage
    const sessionKey = fromHex(SESSION_SECRET!.padEnd(64, '0').slice(0, 64));
    const encryptedKey = await encryptAES(apiKeyBytes, sessionKey);

    const encryptedKeyData = {
      ciphertext: toBase64(encryptedKey.ciphertext),
      iv: toBase64(encryptedKey.iv),
      tag: toBase64(encryptedKey.tag),
    };

    // Calculate expiry
    const expiresAt = new Date(Date.now() + sessionDurationHours * 60 * 60 * 1000);

    // Get client info from request
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';
    const userAgent = req.headers.get('user-agent') || 'unknown';

    // Delete any existing sessions for this user
    await serviceClient
      .from('active_sessions')
      .delete()
      .eq('user_id', auth.userId);

    // Create new session
    const { error: sessionError } = await serviceClient
      .from('active_sessions')
      .insert({
        user_id: auth.userId,
        session_token_hash: sessionTokenHash,
        encrypted_combined_key: JSON.stringify(encryptedKeyData),
        device_fingerprint: deviceFingerprint || null,
        ip_address: clientIp,
        user_agent: userAgent.substring(0, 500),
        expires_at: expiresAt.toISOString(),
      });

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      return errorResponse('Failed to create session');
    }

    // Log the unlock event
    await serviceClient.from('audit_log').insert({
      user_id: auth.userId,
      event_type: 'session_unlocked',
      event_category: 'auth',
      details: {
        provider,
        session_duration_hours: sessionDurationHours,
        device_fingerprint: deviceFingerprint ? 'provided' : 'not_provided',
      },
      ip_address: clientIp,
      user_agent: userAgent.substring(0, 500),
    });

    return jsonResponse({
      success: true,
      sessionToken, // Client stores this to prove session ownership
      expiresAt: expiresAt.toISOString(),
      apiKey, // Return key for client-side use (stored in memory only, not persisted)
      message: 'Session unlocked. You can now close this tab and jobs will continue.',
    });

  } catch (error) {
    console.error('Error unlocking session:', error);
    return errorResponse('Internal server error', 500);
  }
});

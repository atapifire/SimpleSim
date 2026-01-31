/**
 * Unlock Session Edge Function
 * Version: 2026-01-31-v4 (diagnostic)
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

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
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

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVER_PEPPER = Deno.env.get('API_KEY_ENCRYPTION_SECRET');
const SESSION_SECRET = Deno.env.get('SESSION_ENCRYPTION_SECRET') || SERVER_PEPPER;

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const FUNCTION_VERSION = '2026-01-31-v4';

function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message, version: FUNCTION_VERSION }, status);
}

// Inline auth verification to avoid bundling issues
async function verifyAuth(req: Request): Promise<{ userId: string; supabase: SupabaseClient } | { error: string; errorCode: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    console.log('[unlock-session] No Authorization header');
    return { error: 'No Authorization header', errorCode: 'NO_AUTH_HEADER' };
  }

  console.log('[unlock-session] Auth header present, length:', authHeader.length);

  // Extract user ID from token
  let userId: string | null = null;
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(atob(token.split('.')[1]));
    userId = payload.sub || null;
    console.log('[unlock-session] Token payload sub:', userId);
  } catch (e) {
    console.error('[unlock-session] Failed to decode token:', e);
    return { error: 'Invalid token format', errorCode: 'INVALID_TOKEN_FORMAT' };
  }

  if (!userId) {
    return { error: 'No user ID in token', errorCode: 'NO_USER_ID' };
  }

  // Check environment
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[unlock-session] Missing env vars');
    return { error: 'Server configuration error', errorCode: 'MISSING_ENV' };
  }

  // Create client and verify token
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  });

  console.log('[unlock-session] Calling getUser()...');
  try {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) {
      console.error('[unlock-session] getUser error:', error.message);
      return { error: `Token validation failed: ${error.message}`, errorCode: 'TOKEN_VALIDATION_FAILED' };
    }

    if (!user) {
      console.log('[unlock-session] getUser returned no user');
      return { error: 'User not found', errorCode: 'USER_NOT_FOUND' };
    }

    console.log('[unlock-session] Auth successful for user:', user.id);
    return { userId: user.id, supabase };
  } catch (e) {
    console.error('[unlock-session] Exception in getUser:', e);
    return { error: `Exception: ${e.message}`, errorCode: 'EXCEPTION' };
  }
}

function createServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Version check endpoint (GET returns version info)
  if (req.method === 'GET') {
    return jsonResponse({
      function: 'unlock-session',
      version: FUNCTION_VERSION,
      timestamp: new Date().toISOString(),
      envCheck: {
        SUPABASE_URL: SUPABASE_URL ? 'set' : 'NOT SET',
        SUPABASE_ANON_KEY: SUPABASE_ANON_KEY ? 'set' : 'NOT SET',
        SERVER_PEPPER: SERVER_PEPPER ? 'set' : 'NOT SET',
        SESSION_SECRET: SESSION_SECRET ? 'set' : 'NOT SET',
      }
    });
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const auth = await verifyAuth(req);
  if ('error' in auth) {
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

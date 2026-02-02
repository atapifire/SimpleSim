/**
 * Store API Key Edge Function
 * Version: 2026-01-31-v4 (diagnostic)
 *
 * Implements zero-knowledge key storage using Shamir's Secret Sharing:
 * 1. Receives plaintext API key from authenticated user
 * 2. Splits key into 2 shares using Shamir's (2-of-2 threshold)
 * 3. Share A: Encrypted with server pepper, stored in api_keys table
 * 4. Share B: Returned to client for local encryption with user's PIN/Passkey
 *
 * Security: Neither share alone can reconstruct the key.
 * Even a database breach only exposes encrypted Share A.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  splitSecret,
  encryptAES,
  generateKey,
  toBase64,
  fromHex,
} from '../_shared/crypto.ts';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERVER_PEPPER = Deno.env.get('API_KEY_ENCRYPTION_SECRET');

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

const FUNCTION_VERSION = '2026-02-01-v5-multidevice';

function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message, version: FUNCTION_VERSION }, status);
}

// Inline auth verification to avoid bundling issues
async function verifyAuth(req: Request): Promise<{ userId: string; supabase: SupabaseClient } | { error: string; errorCode: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    console.log('[store-api-key] No Authorization header');
    return { error: 'No Authorization header', errorCode: 'NO_AUTH_HEADER' };
  }

  console.log('[store-api-key] Auth header present, length:', authHeader.length);

  // Extract user ID from token
  let userId: string | null = null;
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(atob(token.split('.')[1]));
    userId = payload.sub || null;
    console.log('[store-api-key] Token payload sub:', userId);
  } catch (e) {
    console.error('[store-api-key] Failed to decode token:', e);
    return { error: 'Invalid token format', errorCode: 'INVALID_TOKEN_FORMAT' };
  }

  if (!userId) {
    return { error: 'No user ID in token', errorCode: 'NO_USER_ID' };
  }

  // Check environment
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[store-api-key] Missing env vars');
    return { error: 'Server configuration error', errorCode: 'MISSING_ENV' };
  }

  // Create client and verify token
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  });

  console.log('[store-api-key] Calling getUser()...');
  try {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) {
      console.error('[store-api-key] getUser error:', error.message);
      return { error: `Token validation failed: ${error.message}`, errorCode: 'TOKEN_VALIDATION_FAILED' };
    }

    if (!user) {
      console.log('[store-api-key] getUser returned no user');
      return { error: 'User not found', errorCode: 'USER_NOT_FOUND' };
    }

    console.log('[store-api-key] Auth successful for user:', user.id);
    return { userId: user.id, supabase };
  } catch (e) {
    console.error('[store-api-key] Exception in getUser:', e);
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
      function: 'store-api-key',
      version: FUNCTION_VERSION,
      timestamp: new Date().toISOString(),
      envCheck: {
        SUPABASE_URL: SUPABASE_URL ? 'set' : 'NOT SET',
        SUPABASE_ANON_KEY: SUPABASE_ANON_KEY ? 'set' : 'NOT SET',
        SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'NOT SET',
        SERVER_PEPPER: SERVER_PEPPER ? 'set' : 'NOT SET',
      }
    });
  }

  // Only accept POST for actual key storage
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // Verify authentication
  const auth = await verifyAuth(req);
  if ('error' in auth) {
    console.error('[store-api-key] Auth failed:', auth.errorCode, auth.error);
    return errorResponse(`Unauthorized: ${auth.error} (${auth.errorCode})`, 401);
  }

  // Check server pepper is configured
  if (!SERVER_PEPPER || SERVER_PEPPER.length < 32) {
    console.error('API_KEY_ENCRYPTION_SECRET not configured or too short');
    return errorResponse('Server configuration error', 500);
  }

  try {
    const body = await req.json();
    const {
      apiKey,
      deviceId,
      deviceLabel,
      provider = 'openrouter',
      label = 'Default Key',
      trainingOptOut = true,
      minAgeRequirement = 0,
    } = body;

    // Validate API key format
    if (!apiKey || typeof apiKey !== 'string') {
      return errorResponse('API key is required');
    }

    // Device ID is required for multi-device support
    if (!deviceId || typeof deviceId !== 'string') {
      return errorResponse('Device ID is required');
    }

    console.log(`[store-api-key] Storing key for device: ${deviceId}`);

    // Basic format validation for OpenRouter keys
    if (provider === 'openrouter' && !apiKey.startsWith('sk-or-')) {
      return errorResponse('Invalid OpenRouter API key format');
    }

    // Convert key to bytes
    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(apiKey);

    // Split the key into 2 shares (2-of-2 threshold)
    const [shareA, shareB] = splitSecret(keyBytes, 2, 2);

    // Encrypt Share A with server pepper
    const pepperKey = fromHex(SERVER_PEPPER.padEnd(64, '0').slice(0, 64));
    const encryptedShareA = await encryptAES(shareA, pepperKey);

    // Create the stored data structure for Share A
    const shareAData = {
      ciphertext: toBase64(encryptedShareA.ciphertext),
      iv: toBase64(encryptedShareA.iv),
      tag: toBase64(encryptedShareA.tag),
    };

    // Use service client to bypass RLS for upsert
    const serviceClient = createServiceClient();

    // Check if user already has a key for this device and provider
    // Multi-device: query by user_id + device_id + provider
    const { data: existingKey } = await serviceClient
      .from('api_keys')
      .select('id')
      .eq('user_id', auth.userId)
      .eq('device_id', deviceId)
      .eq('provider', provider)
      .single();

    let keyId: string;

    if (existingKey) {
      // Update existing key for this device
      console.log(`[store-api-key] Updating existing key for device: ${deviceId}`);
      const { error } = await serviceClient
        .from('api_keys')
        .update({
          encrypted_data: shareAData,
          share_a_vault_id: null,
          share_b_encrypted: null,
          key_label: label,
          device_label: deviceLabel || null,
          training_opt_out: trainingOptOut,
          min_age_requirement: minAgeRequirement,
          is_server_encrypted: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingKey.id);

      if (error) {
        console.error('Failed to update key:', error);
        return errorResponse('Failed to update API key');
      }

      keyId = existingKey.id;
    } else {
      // Insert new key for this device
      console.log(`[store-api-key] Creating new key for device: ${deviceId}`);
      const { data: newKey, error } = await serviceClient
        .from('api_keys')
        .insert({
          user_id: auth.userId,
          device_id: deviceId,
          device_label: deviceLabel || null,
          provider,
          encrypted_data: shareAData,
          key_label: label,
          training_opt_out: trainingOptOut,
          min_age_requirement: minAgeRequirement,
          is_server_encrypted: true,
        })
        .select('id')
        .single();

      if (error) {
        console.error('Failed to insert key:', error);
        return errorResponse('Failed to store API key');
      }

      keyId = newKey.id;
    }

    // Log the event (anonymized)
    await serviceClient.from('audit_log').insert({
      user_id: auth.userId,
      event_type: existingKey ? 'key_updated' : 'key_created',
      event_category: 'key_management',
      details: {
        provider,
        key_id: keyId,
        device_id: deviceId,
        device_label: deviceLabel || null,
      },
    });

    // Return Share B to client for local storage
    return jsonResponse({
      success: true,
      keyId,
      deviceId,
      shareB: toBase64(shareB),
      message: 'API key securely stored for this device. Save Share B locally.',
    });

  } catch (error) {
    console.error('Error storing API key:', error);
    return errorResponse('Internal server error', 500);
  }
});

/**
 * Store API Key Edge Function
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

import {
  splitSecret,
  encryptAES,
  generateKey,
  toBase64,
  fromHex,
} from '../_shared/crypto.ts';
import {
  verifyAuth,
  createServiceClient,
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/supabase.ts';

// Server-side encryption pepper (set in Supabase Dashboard -> Edge Functions -> Secrets)
const SERVER_PEPPER = Deno.env.get('API_KEY_ENCRYPTION_SECRET');

Deno.serve(async (req) => {
  // Handle CORS
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Only accept POST
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // Verify authentication
  const auth = await verifyAuth(req);
  if (!auth) {
    return errorResponse('Unauthorized', 401);
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
      provider = 'openrouter',
      label = 'Default Key',
      trainingOptOut = true,
      minAgeRequirement = 0,
    } = body;

    // Validate API key format
    if (!apiKey || typeof apiKey !== 'string') {
      return errorResponse('API key is required');
    }

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

    // Check if user already has a key for this provider
    const { data: existingKey } = await serviceClient
      .from('api_keys')
      .select('id')
      .eq('user_id', auth.userId)
      .eq('provider', provider)
      .single();

    let keyId: string;

    if (existingKey) {
      // Update existing key
      const { error } = await serviceClient
        .from('api_keys')
        .update({
          encrypted_data: shareAData,
          share_a_vault_id: null, // Could use Vault in future
          share_b_encrypted: null, // Share B stored client-side
          key_label: label,
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
      // Insert new key
      const { data: newKey, error } = await serviceClient
        .from('api_keys')
        .insert({
          user_id: auth.userId,
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
      details: { provider, key_id: keyId },
    });

    // Return Share B to client for local storage
    // Client will encrypt this with their PIN/Passkey PRF
    return jsonResponse({
      success: true,
      keyId,
      shareB: toBase64(shareB),
      message: 'API key securely stored. Save Share B locally.',
    });

  } catch (error) {
    console.error('Error storing API key:', error);
    return errorResponse('Internal server error', 500);
  }
});

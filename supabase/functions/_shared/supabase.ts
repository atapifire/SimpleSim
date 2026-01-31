/**
 * Shared Supabase client and utilities for Edge Functions
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Environment variables
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Create a Supabase client with the user's JWT for RLS
 */
export function createUserClient(authHeader: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: authHeader }
    }
  });
}

/**
 * Create a service role client (bypasses RLS)
 */
export function createServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Extract user ID from JWT
 */
export async function getUserIdFromToken(authHeader: string): Promise<string | null> {
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.sub || null;
  } catch {
    return null;
  }
}

/**
 * Auth verification result with error details
 */
export interface AuthResult {
  success: boolean;
  userId?: string;
  supabase?: SupabaseClient;
  error?: string;
  errorCode?: string;
}

/**
 * Verify the request is authenticated (returns detailed error info)
 */
export async function verifyAuthWithDetails(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    console.log('[verifyAuth] No Authorization header');
    return { success: false, error: 'No Authorization header', errorCode: 'NO_AUTH_HEADER' };
  }

  console.log('[verifyAuth] Auth header present, length:', authHeader.length);

  const userId = await getUserIdFromToken(authHeader);
  if (!userId) {
    console.log('[verifyAuth] Could not extract userId from token');
    return { success: false, error: 'Invalid token format - could not extract user ID', errorCode: 'INVALID_TOKEN_FORMAT' };
  }

  console.log('[verifyAuth] Extracted userId:', userId);

  // Check environment variables
  const urlSet = !!SUPABASE_URL;
  const keySet = !!SUPABASE_ANON_KEY;
  console.log('[verifyAuth] SUPABASE_URL:', urlSet ? 'set' : 'NOT SET');
  console.log('[verifyAuth] SUPABASE_ANON_KEY:', keySet ? 'set (length: ' + SUPABASE_ANON_KEY?.length + ')' : 'NOT SET');

  if (!urlSet || !keySet) {
    return { success: false, error: 'Server configuration error - missing Supabase credentials', errorCode: 'MISSING_ENV' };
  }

  const supabase = createUserClient(authHeader);

  // Verify the token is valid by checking the user
  console.log('[verifyAuth] Calling getUser()...');
  try {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) {
      console.error('[verifyAuth] getUser error:', error.message, error);
      return { success: false, error: `Token validation failed: ${error.message}`, errorCode: 'TOKEN_VALIDATION_FAILED' };
    }

    if (!user) {
      console.log('[verifyAuth] getUser returned no user');
      return { success: false, error: 'Token valid but user not found', errorCode: 'USER_NOT_FOUND' };
    }

    console.log('[verifyAuth] Verified user:', user.id);
    return { success: true, userId: user.id, supabase };
  } catch (e) {
    console.error('[verifyAuth] Exception during getUser:', e);
    return { success: false, error: `Exception during token validation: ${e.message}`, errorCode: 'EXCEPTION' };
  }
}

/**
 * Verify the request is authenticated (legacy function for compatibility)
 */
export async function verifyAuth(req: Request): Promise<{
  userId: string;
  supabase: SupabaseClient;
} | null> {
  const result = await verifyAuthWithDetails(req);
  if (result.success && result.userId && result.supabase) {
    return { userId: result.userId, supabase: result.supabase };
  }
  return null;
}

/**
 * Standard CORS headers
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/**
 * Create a JSON response with CORS headers
 */
export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create an error response
 */
export function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Handle CORS preflight
 */
export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}

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
 * Verify the request is authenticated
 */
export async function verifyAuth(req: Request): Promise<{
  userId: string;
  supabase: SupabaseClient;
} | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    console.log('[verifyAuth] No Authorization header');
    return null;
  }

  console.log('[verifyAuth] Auth header present, length:', authHeader.length);

  const userId = await getUserIdFromToken(authHeader);
  if (!userId) {
    console.log('[verifyAuth] Could not extract userId from token');
    return null;
  }

  console.log('[verifyAuth] Extracted userId:', userId);

  // Check environment variables
  console.log('[verifyAuth] SUPABASE_URL:', SUPABASE_URL ? 'set' : 'NOT SET');
  console.log('[verifyAuth] SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? 'set (length: ' + SUPABASE_ANON_KEY?.length + ')' : 'NOT SET');

  const supabase = createUserClient(authHeader);

  // Verify the token is valid by checking the user
  console.log('[verifyAuth] Calling getUser()...');
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error) {
    console.error('[verifyAuth] getUser error:', error.message, error);
    return null;
  }

  if (!user) {
    console.log('[verifyAuth] getUser returned no user');
    return null;
  }

  console.log('[verifyAuth] Verified user:', user.id);
  return { userId: user.id, supabase };
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

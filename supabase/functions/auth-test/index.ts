/**
 * Auth Test Edge Function
 *
 * Diagnostic endpoint to test authentication flow.
 * Returns detailed information about the auth token and verification process.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const diagnostics: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    method: req.method,
    envCheck: {
      SUPABASE_URL: SUPABASE_URL ? `set (${SUPABASE_URL.substring(0, 30)}...)` : 'NOT SET',
      SUPABASE_ANON_KEY: SUPABASE_ANON_KEY ? `set (length: ${SUPABASE_ANON_KEY.length})` : 'NOT SET',
    },
  };

  // Check Authorization header
  const authHeader = req.headers.get('Authorization');
  diagnostics.authHeader = {
    present: !!authHeader,
    length: authHeader?.length || 0,
    preview: authHeader ? authHeader.substring(0, 50) + '...' : null,
  };

  if (!authHeader) {
    return new Response(JSON.stringify({
      success: false,
      error: 'No Authorization header',
      diagnostics,
    }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Extract and decode token
  const token = authHeader.replace('Bearer ', '');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      diagnostics.tokenFormat = 'invalid - not 3 parts';
    } else {
      const payload = JSON.parse(atob(parts[1]));
      diagnostics.tokenPayload = {
        sub: payload.sub,
        aud: payload.aud,
        role: payload.role,
        exp: payload.exp,
        expDate: new Date(payload.exp * 1000).toISOString(),
        iat: payload.iat,
        iatDate: new Date(payload.iat * 1000).toISOString(),
        iss: payload.iss,
      };

      const now = Math.floor(Date.now() / 1000);
      diagnostics.tokenStatus = {
        isExpired: now > payload.exp,
        expiresIn: payload.exp - now,
        secondsSinceIssued: now - payload.iat,
      };
    }
  } catch (e) {
    diagnostics.tokenDecodeError = e.message;
  }

  // Check environment
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Server configuration error - missing Supabase credentials',
      diagnostics,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Create Supabase client and try to get user
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: authHeader }
    }
  });

  diagnostics.getUserAttempt = { started: new Date().toISOString() };

  try {
    const { data: { user }, error } = await supabase.auth.getUser();

    diagnostics.getUserAttempt.completed = new Date().toISOString();

    if (error) {
      diagnostics.getUserAttempt.error = {
        message: error.message,
        status: error.status,
        name: error.name,
      };
      return new Response(JSON.stringify({
        success: false,
        error: `getUser failed: ${error.message}`,
        diagnostics,
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!user) {
      diagnostics.getUserAttempt.result = 'no user returned';
      return new Response(JSON.stringify({
        success: false,
        error: 'getUser returned no user',
        diagnostics,
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    diagnostics.getUserAttempt.result = {
      userId: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
    };

    return new Response(JSON.stringify({
      success: true,
      message: 'Authentication successful',
      user: {
        id: user.id,
        email: user.email,
      },
      diagnostics,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    diagnostics.getUserAttempt.exception = e.message;
    return new Response(JSON.stringify({
      success: false,
      error: `Exception during getUser: ${e.message}`,
      diagnostics,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

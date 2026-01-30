/**
 * Security Headers for Edge Functions
 * Implements strict CSP and other security measures
 */

/**
 * Content Security Policy for SimpleSim
 * Prevents XSS, data exfiltration, and other attacks
 */
export const CSP_POLICY = [
  // Only allow scripts from same origin and trusted CDNs
  "default-src 'self'",

  // Scripts: Tailwind CDN, Font Awesome, and inline (required for Supabase)
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://esm.sh https://cdnjs.cloudflare.com",

  // Styles: Tailwind, Google Fonts, Font Awesome
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",

  // Fonts: Google Fonts, Font Awesome
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",

  // Images: Picsum (placeholder), data URIs
  "img-src 'self' https://picsum.photos https://*.githubusercontent.com data: blob:",

  // Connect: Only allow API calls to trusted endpoints
  "connect-src 'self' https://ouvrecllkqtwbtrwyhgw.supabase.co wss://ouvrecllkqtwbtrwyhgw.supabase.co https://openrouter.ai https://api.github.com",

  // Frames: Block all framing except preview iframe
  "frame-src 'self' blob:",

  // Block all object/embed/applet
  "object-src 'none'",

  // Block form actions to external sites
  "form-action 'self'",

  // Upgrade insecure requests
  "upgrade-insecure-requests",

  // Report violations (optional - set up endpoint if needed)
  // "report-uri /api/csp-report"
].join('; ');

/**
 * All security headers for responses
 */
export const securityHeaders = {
  // Content Security Policy
  'Content-Security-Policy': CSP_POLICY,

  // Prevent MIME type sniffing
  'X-Content-Type-Options': 'nosniff',

  // Enable browser XSS filter
  'X-XSS-Protection': '1; mode=block',

  // Prevent clickjacking
  'X-Frame-Options': 'SAMEORIGIN',

  // Referrer policy - don't leak URLs to third parties
  'Referrer-Policy': 'strict-origin-when-cross-origin',

  // Permissions policy - disable unnecessary features
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',

  // HSTS - force HTTPS (1 year)
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/**
 * CORS headers (separate from security headers)
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // Restrict in production
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
  'Access-Control-Max-Age': '86400',
};

/**
 * Rate limiting configuration
 */
export const rateLimitConfig = {
  // Requests per window
  maxRequests: 100,
  windowMs: 60 * 1000, // 1 minute

  // Key generation attempts before lockout
  maxKeyAttempts: 5,
  keyLockoutMs: 60 * 60 * 1000, // 1 hour

  // Session unlock attempts before lockout
  maxUnlockAttempts: 5,
  unlockLockoutMs: 15 * 60 * 1000, // 15 minutes
};

/**
 * Validate request origin (for additional CSRF protection)
 */
export function validateOrigin(req: Request, allowedOrigins: string[]): boolean {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  // Check origin header
  if (origin && allowedOrigins.some(allowed => origin.startsWith(allowed))) {
    return true;
  }

  // Check referer as fallback
  if (referer && allowedOrigins.some(allowed => referer.startsWith(allowed))) {
    return true;
  }

  // Allow requests without origin (server-to-server)
  if (!origin && !referer) {
    return true;
  }

  return false;
}

/**
 * Sanitize user input to prevent injection
 */
export function sanitizeInput(input: string, maxLength: number = 10000): string {
  if (typeof input !== 'string') return '';

  return input
    .slice(0, maxLength)
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

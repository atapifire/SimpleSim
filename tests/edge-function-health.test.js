/**
 * Edge Function Health Tests
 * Verifies that Edge Functions are deployed and responding correctly
 *
 * Run with: npm test -- tests/edge-function-health.test.js
 */

import { describe, it, expect, beforeAll } from 'vitest';

const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// List of expected Edge Functions
const EXPECTED_FUNCTIONS = [
    'process-job',
    'job-scheduler',
    'unlock-session',
    'store-api-key',
    'auth-test'
];

describe('Edge Function Health Checks', () => {
    describe('Function Endpoints', () => {
        EXPECTED_FUNCTIONS.forEach(funcName => {
            it(`should have ${funcName} function responding`, async () => {
                const response = await fetch(`${FUNCTIONS_URL}/${funcName}`, {
                    method: 'OPTIONS', // CORS preflight - always works
                });

                // OPTIONS should return 200 with CORS headers
                expect(response.status).toBe(200);
                expect(response.headers.get('access-control-allow-origin')).toBe('*');
            });
        });
    });

    describe('Function Error Handling', () => {
        it('should return 401 for unauthorized process-job calls', async () => {
            const response = await fetch(`${FUNCTIONS_URL}/process-job`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            // Should reject without auth
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body).toHaveProperty('message');
        });

        it('should return 401 for unauthorized job-scheduler calls', async () => {
            const response = await fetch(`${FUNCTIONS_URL}/job-scheduler`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            // Should reject without auth
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body).toHaveProperty('message');
        });

        it('should return 401 for unauthorized unlock-session calls', async () => {
            const response = await fetch(`${FUNCTIONS_URL}/unlock-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shareB: 'test', deviceId: 'test' })
            });

            // Should reject without auth
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(body).toHaveProperty('error');
        });
    });

    describe('CORS Configuration', () => {
        it('should have proper CORS headers on all functions', async () => {
            for (const funcName of EXPECTED_FUNCTIONS) {
                const response = await fetch(`${FUNCTIONS_URL}/${funcName}`, {
                    method: 'OPTIONS',
                    headers: {
                        'Origin': 'http://localhost:3000',
                        'Access-Control-Request-Method': 'POST'
                    }
                });

                expect(response.headers.get('access-control-allow-origin')).toBe('*');
                expect(response.headers.get('access-control-allow-methods')).toContain('POST');
            }
        });
    });
});

describe('Supabase API Connectivity', () => {
    it('should have REST API endpoint responding', async () => {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
            headers: {
                'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91dnJlY2xsa3F0d2J0cnd5aGd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzgwOTA2MTMsImV4cCI6MjA1MzY2NjYxM30.SXRqjUlqoLnFv0eYMC2kZh_oPzCm2qcOaX6MbQlNB-Y'
            }
        });

        // Should return something (200, 401, or 404 are all valid responses)
        expect([200, 401, 404]).toContain(response.status);
    });

    it('should have realtime endpoint responding', async () => {
        // Just verify the endpoint exists
        const response = await fetch(`${SUPABASE_URL}/realtime/v1/`, {
            method: 'GET'
        });

        // Realtime endpoint exists - may return various codes depending on auth
        expect([101, 200, 400, 401, 426]).toContain(response.status);
    });
});

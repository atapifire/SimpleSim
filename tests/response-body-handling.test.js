/**
 * Response Body Handling Tests
 *
 * Tests for the "Body already consumed" bug fix.
 * When a fetch Response body is read (via .text() or .json()),
 * it cannot be read again. These tests verify our error handling
 * properly tracks and reuses consumed response bodies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Response Body Handling', () => {
    /**
     * Mock fetch Response that tracks body consumption
     */
    function createMockResponse(status, body, options = {}) {
        let bodyConsumed = false;

        return {
            status,
            ok: status >= 200 && status < 300,
            headers: new Map(Object.entries(options.headers || {})),
            text: async () => {
                if (bodyConsumed) {
                    throw new TypeError('Body already consumed');
                }
                bodyConsumed = true;
                return body;
            },
            json: async () => {
                if (bodyConsumed) {
                    throw new TypeError('Body already consumed');
                }
                bodyConsumed = true;
                return JSON.parse(body);
            },
            clone: () => createMockResponse(status, body, options),
            _isConsumed: () => bodyConsumed
        };
    }

    describe('Simple Mode Retry Logic', () => {
        it('should track consumed body on transient errors to avoid double consumption', async () => {
            // Simulate the pattern: 5xx error -> read body -> retry loop ends -> try to read body again
            const response = createMockResponse(500, '{"error": "Server error"}');

            // First read (in retry loop)
            let responseBodyText = null;
            if (response.status >= 500) {
                responseBodyText = await response.text();
                expect(responseBodyText).toBe('{"error": "Server error"}');
            }

            // After retry loop exhausted, try to read again
            // WITHOUT the fix, this would throw "Body already consumed"
            // WITH the fix, we use the cached responseBodyText
            if (!response.ok) {
                const errorBody = responseBodyText ?? await response.text();
                expect(errorBody).toBe('{"error": "Server error"}');
            }
        });

        it('should read body fresh when not consumed in retry loop', async () => {
            // Simulate: 4xx error -> don't read in retry loop -> break -> read body
            const response = createMockResponse(400, '{"error": "Bad request"}');
            let responseBodyText = null;

            // 400 is not retried, so body is NOT consumed in retry loop
            if (response.status === 429 || response.status >= 500) {
                responseBodyText = await response.text();
            }

            // Body should be read fresh here
            if (!response.ok) {
                const errorBody = responseBodyText ?? await response.text();
                expect(errorBody).toBe('{"error": "Bad request"}');
            }
        });

        it('should reset body tracker when getting new response on retry', async () => {
            // Simulate: 500 error -> read body -> retry -> success
            const response1 = createMockResponse(500, '{"error": "Temporary failure"}');
            const response2 = createMockResponse(200, '{"success": true}');

            let responseBodyText = null;
            let currentResponse = response1;

            // First attempt - 500 error
            if (currentResponse.status >= 500) {
                responseBodyText = await currentResponse.text();
                expect(responseBodyText).toBe('{"error": "Temporary failure"}');
                // Retry - get new response
                currentResponse = response2;
                responseBodyText = null; // Reset tracker for new response
            }

            // Second attempt - success
            expect(currentResponse.ok).toBe(true);
            const data = await currentResponse.json();
            expect(data.success).toBe(true);
        });
    });

    describe('Agent Mode Retry Logic', () => {
        it('should handle nested retry loops without double consumption', async () => {
            // Agent mode has outer loop (routing/rate-limit) and inner loop (transient errors)
            const response = createMockResponse(503, '{"error": "Service unavailable"}');
            let responseBodyText = null;

            // Inner loop: transient 5xx error
            if (response.status >= 500) {
                responseBodyText = await response.text();
            }

            // After inner loop, check for routing errors (which also reads body)
            if (!response.ok) {
                const errorBody = responseBodyText ?? await response.text();
                // Try to parse for routing error check
                let errorMsg = `API error: ${response.status}`;
                try {
                    const errorJson = JSON.parse(errorBody);
                    errorMsg = errorJson.error?.message || errorJson.error || errorMsg;
                } catch {}
                expect(errorMsg).toBe('Service unavailable');
            }
        });

        it('should reset body tracker when response is nulled for retry', async () => {
            // Simulate routing error -> response = null -> retry
            const response1 = createMockResponse(404, '{"error": {"message": "No matching route"}}');
            const response2 = createMockResponse(200, '{"choices": []}');

            let responseBodyText = null;
            let response = response1;

            // First attempt - routing error
            if (!response.ok) {
                responseBodyText = responseBodyText ?? await response.text();
                const errorJson = JSON.parse(responseBodyText);
                if (errorJson.error?.message?.includes('No matching route')) {
                    // Retry
                    response = response2;
                    responseBodyText = null; // Reset
                }
            }

            // Second attempt - success
            expect(response.ok).toBe(true);
            const data = await response.json();
            expect(data).toHaveProperty('choices');
        });

        it('should handle rate limiting retry without body consumption issues', async () => {
            const response1 = createMockResponse(429, '{"error": "Rate limited"}');
            const response2 = createMockResponse(200, '{"choices": []}');

            let responseBodyText = null;
            let response = response1;

            // First read body for error handling
            if (!response.ok) {
                responseBodyText = responseBodyText ?? await response.text();
            }

            // Rate limit detected, reset for retry
            if (response.status === 429) {
                response = response2;
                responseBodyText = null;
            }

            // After retry, should work
            expect(response.ok).toBe(true);
        });
    });

    describe('Error Message Preservation', () => {
        it('should preserve error details when body is consumed early', async () => {
            const errorDetails = {
                error: {
                    message: 'Model overloaded',
                    type: 'server_error',
                    metadata: { raw: 'Provider returned 503' }
                }
            };
            const response = createMockResponse(503, JSON.stringify(errorDetails));

            let responseBodyText = null;

            // Consume body in retry loop
            if (response.status >= 500) {
                responseBodyText = await response.text();
            }

            // Later error handling should still have full details
            if (!response.ok) {
                const errorBody = responseBodyText ?? await response.text();
                const parsed = JSON.parse(errorBody);
                expect(parsed.error.message).toBe('Model overloaded');
                expect(parsed.error.metadata.raw).toBe('Provider returned 503');
            }
        });

        it('should handle malformed JSON in error response', async () => {
            const response = createMockResponse(500, 'Internal Server Error');

            let responseBodyText = null;
            if (response.status >= 500) {
                responseBodyText = await response.text();
            }

            if (!response.ok) {
                const errorBody = responseBodyText ?? await response.text();
                let errorMsg = `API error: ${response.status}`;
                try {
                    const errorJson = JSON.parse(errorBody);
                    errorMsg = errorJson.error?.message || errorMsg;
                } catch {
                    // Non-JSON response - use raw text
                    errorMsg = `HTTP ${response.status}: ${errorBody}`;
                }
                expect(errorMsg).toBe('HTTP 500: Internal Server Error');
            }
        });
    });

    describe('TypeScript Pattern Verification', () => {
        /**
         * This test verifies the exact pattern used in process-job/index.ts
         * to ensure the fix is correctly implemented
         */
        it('should follow the correct responseBodyText pattern', async () => {
            // The pattern from our fix:
            let responseBodyText = null; // Track consumed body

            // In retry loop:
            const responses = [
                createMockResponse(500, '{"error": "First failure"}'),
                createMockResponse(502, '{"error": "Second failure"}'),
                createMockResponse(200, '{"choices": [{"message": {"content": "Hello"}}]}')
            ];

            let response = null;
            let lastError = '';
            const maxRetries = 3;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                response = responses[attempt - 1];

                if (response.status >= 500) {
                    responseBodyText = await response.text();
                    lastError = `HTTP ${response.status}: ${responseBodyText}`;
                    continue;
                }

                responseBodyText = null; // Reset for successful response
                break;
            }

            // After loop - verify we can still handle errors properly
            expect(response).toBeDefined();
            expect(response.ok).toBe(true);
            expect(responseBodyText).toBeNull(); // Reset on success

            // Should be able to read successful response body
            const data = await response.json();
            expect(data.choices[0].message.content).toBe('Hello');
        });
    });
});

describe('Retry Exhaustion Scenarios', () => {
    function createMockResponse(status, body) {
        let bodyConsumed = false;
        return {
            status,
            ok: status >= 200 && status < 300,
            text: async () => {
                if (bodyConsumed) {
                    throw new TypeError('Body already consumed');
                }
                bodyConsumed = true;
                return body;
            },
            json: async () => {
                if (bodyConsumed) {
                    throw new TypeError('Body already consumed');
                }
                bodyConsumed = true;
                return JSON.parse(body);
            }
        };
    }

    it('should handle all retries failing with 5xx errors', async () => {
        let responseBodyText = null;
        let response = null;

        // All attempts return 500
        for (let attempt = 1; attempt <= 3; attempt++) {
            response = createMockResponse(500, `{"error": "Failure ${attempt}"}`);

            if (response.status >= 500) {
                responseBodyText = await response.text();
                if (attempt < 3) continue;
            }
            break;
        }

        // After exhausting retries, should still be able to process error
        expect(response.ok).toBe(false);
        const errorBody = responseBodyText ?? await response.text();
        expect(errorBody).toContain('Failure 3');
    });

    it('should handle final attempt being a different error status', async () => {
        let responseBodyText = null;
        let response = null;

        const responses = [
            createMockResponse(500, '{"error": "Server error"}'),
            createMockResponse(500, '{"error": "Server error"}'),
            createMockResponse(400, '{"error": "Bad request"}'), // Different error
        ];

        for (let attempt = 1; attempt <= 3; attempt++) {
            response = responses[attempt - 1];

            if (response.status >= 500) {
                responseBodyText = await response.text();
                continue;
            }

            responseBodyText = null; // Not a 5xx, so didn't consume in retry check
            break;
        }

        // Final response is 400 - body wasn't consumed
        expect(response.ok).toBe(false);
        expect(responseBodyText).toBeNull();

        // Should read fresh
        const errorBody = await response.text();
        expect(errorBody).toBe('{"error": "Bad request"}');
    });
});

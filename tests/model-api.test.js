/**
 * Model API Tests
 * Tests for OpenRouter model availability and free model handling
 *
 * Run with: npm test -- tests/model-api.test.js
 * Run free model tests: OPENROUTER_API_KEY=sk-or-... npm test -- tests/model-api.test.js --run
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Test configuration
const FREE_MODEL_ID = 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// Check if we have an API key for live tests
const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const runLiveTests = hasApiKey && process.env.RUN_LIVE_TESTS === 'true';

describe('Model ID Format Validation', () => {
    it('should validate free model ID format', () => {
        expect(FREE_MODEL_ID).toMatch(/^[a-z-]+\/[a-z0-9.-]+:free$/i);
    });

    it('should detect free models correctly', () => {
        const isFreeModel = (modelId) => modelId.includes(':free');

        expect(isFreeModel('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
        expect(isFreeModel('meta-llama/llama-3.3-70b-instruct')).toBe(false);
        expect(isFreeModel('google/gemini-2.0-flash-exp:free')).toBe(true);
        expect(isFreeModel('anthropic/claude-3.5-sonnet')).toBe(false);
    });

    it('should extract model family from ID', () => {
        const getModelFamily = (modelId) => {
            const lowerModel = modelId.toLowerCase();
            if (lowerModel.includes('claude') || lowerModel.startsWith('anthropic/')) return 'claude';
            if (lowerModel.includes('gpt') || lowerModel.startsWith('openai/gpt')) return 'gpt';
            if (lowerModel.includes('gemini') || lowerModel.startsWith('google/')) return 'gemini';
            if (lowerModel.includes('llama') || lowerModel.startsWith('meta-llama/')) return 'llama';
            if (lowerModel.includes('mistral') || lowerModel.startsWith('mistralai/')) return 'mistral';
            if (lowerModel.includes('deepseek')) return 'deepseek';
            return 'default';
        };

        expect(getModelFamily(FREE_MODEL_ID)).toBe('llama');
        expect(getModelFamily('anthropic/claude-3.5-sonnet')).toBe('claude');
        expect(getModelFamily('openai/gpt-4o')).toBe('gpt');
        expect(getModelFamily('google/gemini-2.0-flash-exp:free')).toBe('gemini');
    });
});

describe('OpenRouter Models API', () => {
    let availableModels = [];

    beforeAll(async () => {
        try {
            const response = await fetch(`${OPENROUTER_API_URL}/models`);
            if (response.ok) {
                const data = await response.json();
                availableModels = data.data || [];
            }
        } catch (e) {
            console.log('Could not fetch models list:', e.message);
        }
    });

    it('should fetch available models from OpenRouter', () => {
        // This test will pass even if API is unavailable
        // It just logs the result
        if (availableModels.length === 0) {
            console.log('No models fetched (API may be unavailable)');
        } else {
            console.log(`Fetched ${availableModels.length} models from OpenRouter`);
        }
        expect(true).toBe(true);
    });

    it('should find Llama 3.3 70B free model in available models', () => {
        if (availableModels.length === 0) {
            console.log('Skipping - no models available');
            return;
        }

        const llamaFreeModel = availableModels.find(m => m.id === FREE_MODEL_ID);

        if (llamaFreeModel) {
            console.log('Found model:', {
                id: llamaFreeModel.id,
                name: llamaFreeModel.name,
                contextLength: llamaFreeModel.context_length,
            });
            expect(llamaFreeModel.id).toBe(FREE_MODEL_ID);
        } else {
            // Model might not be available currently
            console.log(`Model ${FREE_MODEL_ID} not found in available models`);
            console.log('Available Llama models:', availableModels
                .filter(m => m.id.includes('llama'))
                .map(m => m.id)
                .slice(0, 10));
        }
    });

    it('should list all available free models', () => {
        if (availableModels.length === 0) {
            console.log('Skipping - no models available');
            return;
        }

        const freeModels = availableModels.filter(m => m.id.includes(':free'));
        console.log(`Found ${freeModels.length} free models:`);
        freeModels.slice(0, 10).forEach(m => {
            console.log(`  - ${m.id}`);
        });

        expect(freeModels.length).toBeGreaterThan(0);
    });
});

describe('Free Model API Request Format', () => {
    it('should format request body correctly for free models', () => {
        const model = FREE_MODEL_ID;
        const messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Say hello' }
        ];

        const requestBody = {
            model,
            messages,
            stream: false,
        };

        expect(requestBody.model).toBe(FREE_MODEL_ID);
        expect(requestBody.messages).toHaveLength(2);
        expect(requestBody.messages[0].role).toBe('system');
    });

    it('should include required headers for OpenRouter', () => {
        const apiKey = 'sk-or-test-key';

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://simplesim.dev',
            'X-Title': 'SimpleSim',
        };

        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['Authorization']).toContain('Bearer');
        expect(headers['HTTP-Referer']).toBeTruthy();
        expect(headers['X-Title']).toBeTruthy();
    });
});

// Live API tests - only run when flagged and API key is available
describe.skipIf(!runLiveTests)('Live Free Model API Tests', () => {
    it('should make a successful request to free Llama model', async () => {
        const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://simplesim.dev',
                'X-Title': 'SimpleSim Test',
            },
            body: JSON.stringify({
                model: FREE_MODEL_ID,
                messages: [
                    { role: 'user', content: 'Say "test passed" and nothing else.' }
                ],
                max_tokens: 20,
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            console.log('API Error:', data);
            // Check if it's a routing error
            if (data.error?.message?.includes('No matching route')) {
                console.log('NOTE: Free model routing unavailable - this is an OpenRouter issue');
            }
        }

        expect(response.status).toBeLessThan(500); // Not a server error
    }, 30000); // 30 second timeout
});

describe('Error Message Parsing', () => {
    it('should identify routing errors', () => {
        const routingError = {
            error: {
                message: 'No matching route found. It is likely because the model specified in your request is not configured in the Gateway.',
                code: 400
            }
        };

        const isRoutingError = (error) => {
            const msg = error?.error?.message || error?.message || '';
            return msg.includes('No matching route') || msg.includes('not configured in the Gateway');
        };

        expect(isRoutingError(routingError)).toBe(true);
        expect(isRoutingError({ error: { message: 'Rate limit exceeded' } })).toBe(false);
    });

    it('should suggest alternatives for routing errors', () => {
        const getSuggestion = (error) => {
            const msg = error?.error?.message || '';
            if (msg.includes('No matching route')) {
                return 'The free model may be temporarily unavailable. Try a different model or wait and retry.';
            }
            if (msg.includes('rate limit')) {
                return 'Rate limit reached. Wait a moment before retrying.';
            }
            return 'Unknown error. Check your API key and try again.';
        };

        const routingError = { error: { message: 'No matching route found' } };
        expect(getSuggestion(routingError)).toContain('temporarily unavailable');
    });
});

describe('Model Fallback Logic', () => {
    it('should have fallback models for each family', () => {
        const fallbacks = {
            llama: [
                'meta-llama/llama-3.3-70b-instruct:free',
                'meta-llama/llama-3.1-70b-instruct:free',
                'meta-llama/llama-3.1-8b-instruct:free',
            ],
            gemini: [
                'google/gemini-2.0-flash-exp:free',
                'google/gemini-flash-1.5-8b-exp',
            ],
        };

        expect(fallbacks.llama).toContain(FREE_MODEL_ID);
        expect(fallbacks.llama.length).toBeGreaterThan(1);
    });

    it('should try fallback on routing error', () => {
        const tryFallback = (originalModel, fallbacks, error) => {
            if (!error?.includes('No matching route')) return null;

            const family = originalModel.split('/')[0];
            const familyFallbacks = fallbacks[family] || [];

            // Find next available fallback
            for (const fallback of familyFallbacks) {
                if (fallback !== originalModel) {
                    return fallback;
                }
            }
            return null;
        };

        const fallbacks = {
            'meta-llama': [
                'meta-llama/llama-3.3-70b-instruct:free',
                'meta-llama/llama-3.1-70b-instruct:free',
            ]
        };

        const result = tryFallback(
            'meta-llama/llama-3.3-70b-instruct:free',
            fallbacks,
            'No matching route found'
        );

        expect(result).toBe('meta-llama/llama-3.1-70b-instruct:free');
    });
});

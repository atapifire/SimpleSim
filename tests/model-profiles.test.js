import { describe, it, expect } from 'vitest';
import {
    getModelFamily,
    getModelProfile,
    getContextLimit,
    getOutputLimit,
    shouldUseAgentMode,
    prefersEditFormat,
    getPromptStyle,
    getJsonReliability
} from '../model-profiles.js';

describe('getModelFamily', () => {
    it('should detect Claude models', () => {
        expect(getModelFamily('anthropic/claude-3.5-sonnet')).toBe('claude');
        expect(getModelFamily('anthropic/claude-3-opus')).toBe('claude');
    });

    it('should detect GPT models', () => {
        expect(getModelFamily('openai/gpt-4')).toBe('gpt');
        expect(getModelFamily('openai/gpt-4-turbo')).toBe('gpt');
        expect(getModelFamily('openai/gpt-3.5-turbo')).toBe('gpt');
    });

    it('should detect Gemini models', () => {
        expect(getModelFamily('google/gemini-pro')).toBe('gemini');
        expect(getModelFamily('google/gemini-1.5-pro')).toBe('gemini');
    });

    it('should detect Llama models', () => {
        expect(getModelFamily('meta-llama/llama-3.1-70b')).toBe('llama');
    });

    it('should detect Mistral models', () => {
        expect(getModelFamily('mistralai/mistral-large')).toBe('mistral');
    });

    it('should detect DeepSeek models', () => {
        expect(getModelFamily('deepseek/deepseek-coder')).toBe('deepseek');
    });

    it('should return default for unknown models', () => {
        expect(getModelFamily('unknown/model')).toBe('default');
        expect(getModelFamily('')).toBe('default');
    });
});

describe('getModelProfile', () => {
    it('should return Claude profile', () => {
        const profile = getModelProfile('anthropic/claude-3.5-sonnet');
        expect(profile.family).toBe('claude');
        expect(profile.promptStyle).toBe('xml-tags');
        expect(profile.contextWindow).toBe(200000);
    });

    it('should return GPT profile', () => {
        const profile = getModelProfile('openai/gpt-4');
        expect(profile.family).toBe('gpt');
        expect(profile.promptStyle).toBe('markdown');
        expect(profile.jsonReliability).toBe('high');
    });

    it('should return Gemini profile with large context', () => {
        const profile = getModelProfile('google/gemini-1.5-pro');
        expect(profile.family).toBe('gemini');
        expect(profile.contextWindow).toBe(1000000);
    });

    it('should return default profile for unknown models', () => {
        const profile = getModelProfile('unknown/model');
        expect(profile.family).toBe('default');
        expect(profile.contextWindow).toBe(32000);
    });
});

describe('getContextLimit', () => {
    it('should return 60% of context window', () => {
        // Claude has 200k context, so safe limit is 120k
        const limit = getContextLimit('anthropic/claude-3.5-sonnet');
        expect(limit).toBe(120000);
    });

    it('should handle Gemini large context', () => {
        const limit = getContextLimit('google/gemini-1.5-pro');
        expect(limit).toBe(600000); // 60% of 1M
    });
});

describe('getOutputLimit', () => {
    it('should return correct output limits', () => {
        expect(getOutputLimit('anthropic/claude-3.5-sonnet')).toBe(8192);
        expect(getOutputLimit('openai/gpt-4')).toBe(16384);
        expect(getOutputLimit('unknown/model')).toBe(4096);
    });
});

describe('shouldUseAgentMode', () => {
    it('should recommend agent mode for Claude', () => {
        expect(shouldUseAgentMode('anthropic/claude-3.5-sonnet')).toBe(true);
    });

    it('should recommend agent mode for GPT', () => {
        expect(shouldUseAgentMode('openai/gpt-4')).toBe(true);
    });

    it('should not recommend agent mode for unknown models', () => {
        expect(shouldUseAgentMode('unknown/model')).toBe(false);
    });
});

describe('prefersEditFormat', () => {
    it('should prefer edit format for Claude', () => {
        expect(prefersEditFormat('anthropic/claude-3.5-sonnet')).toBe(true);
    });

    it('should not prefer edit format for Gemini (large context)', () => {
        expect(prefersEditFormat('google/gemini-1.5-pro')).toBe(false);
    });

    it('should prefer edit format for Llama', () => {
        expect(prefersEditFormat('meta-llama/llama-3.1-70b')).toBe(true);
    });
});

describe('getPromptStyle', () => {
    it('should return xml-tags for Claude', () => {
        expect(getPromptStyle('anthropic/claude-3.5-sonnet')).toBe('xml-tags');
    });

    it('should return markdown for other models', () => {
        expect(getPromptStyle('openai/gpt-4')).toBe('markdown');
        expect(getPromptStyle('google/gemini-pro')).toBe('markdown');
        expect(getPromptStyle('unknown/model')).toBe('markdown');
    });
});

describe('getJsonReliability', () => {
    it('should return high for Claude and GPT', () => {
        expect(getJsonReliability('anthropic/claude-3.5-sonnet')).toBe('high');
        expect(getJsonReliability('openai/gpt-4')).toBe('high');
    });

    it('should return medium for Gemini and Llama', () => {
        expect(getJsonReliability('google/gemini-pro')).toBe('medium');
        expect(getJsonReliability('meta-llama/llama-3.1-70b')).toBe('medium');
    });

    it('should return low for unknown models', () => {
        expect(getJsonReliability('unknown/model')).toBe('low');
    });
});

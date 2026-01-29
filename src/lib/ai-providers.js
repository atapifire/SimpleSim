/**
 * AI Provider Clients (BYOK - Bring Your Own Keys)
 *
 * All API calls are made directly from the browser using the user's keys.
 * Keys are stored encrypted in localStorage and never sent to our servers.
 */

// ============================================
// OPENROUTER - Text/Code Generation
// ============================================

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Generate code/text using OpenRouter
 * Supports all models available on OpenRouter (Claude, GPT-4, Gemini, etc.)
 */
export async function generateWithOpenRouter(options) {
    const {
        apiKey,
        model = 'anthropic/claude-3.5-sonnet',
        messages,
        maxTokens = 4096,
        temperature = 0.7,
        jsonMode = false
    } = options;

    if (!apiKey) {
        throw new Error('OpenRouter API key is required');
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': window.location.origin,
            'X-Title': 'SimpleSim'
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            ...(jsonMode && { response_format: { type: 'json_object' } })
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenRouter API error');
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

/**
 * Fetch available models from OpenRouter
 */
export async function getOpenRouterModels(apiKey) {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: {
            'Authorization': `Bearer ${apiKey}`
        }
    });

    if (!response.ok) {
        throw new Error('Failed to fetch models');
    }

    const data = await response.json();
    return data.data;
}

/**
 * Check OpenRouter API key validity and get credits
 */
export async function checkOpenRouterCredits(apiKey) {
    const response = await fetch(`${OPENROUTER_BASE_URL}/auth/key`, {
        headers: {
            'Authorization': `Bearer ${apiKey}`
        }
    });

    if (!response.ok) {
        throw new Error('Invalid API key');
    }

    return response.json();
}

// ============================================
// HUGGINGFACE - Images, TTS, Custom Models
// ============================================

const HF_INFERENCE_BASE = 'https://api-inference.huggingface.co/models';

/**
 * Generate an image using HuggingFace Inference API
 */
export async function generateImage(options) {
    const {
        apiKey,
        model = 'stabilityai/stable-diffusion-xl-base-1.0',
        prompt,
        negativePrompt = '',
        width = 1024,
        height = 1024
    } = options;

    if (!apiKey) {
        throw new Error('HuggingFace API key is required');
    }

    const response = await fetch(`${HF_INFERENCE_BASE}/${model}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            inputs: prompt,
            parameters: {
                negative_prompt: negativePrompt,
                width,
                height
            }
        })
    });

    if (!response.ok) {
        // Check if model is loading
        if (response.status === 503) {
            const error = await response.json();
            if (error.estimated_time) {
                throw new Error(`Model is loading, please wait ~${Math.ceil(error.estimated_time)}s and try again`);
            }
        }
        throw new Error('Image generation failed');
    }

    // Response is the image blob directly
    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

/**
 * Text-to-Speech using HuggingFace
 */
export async function generateSpeech(options) {
    const {
        apiKey,
        model = 'facebook/mms-tts-eng',
        text
    } = options;

    if (!apiKey) {
        throw new Error('HuggingFace API key is required');
    }

    const response = await fetch(`${HF_INFERENCE_BASE}/${model}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: text })
    });

    if (!response.ok) {
        if (response.status === 503) {
            const error = await response.json();
            if (error.estimated_time) {
                throw new Error(`Model is loading, please wait ~${Math.ceil(error.estimated_time)}s and try again`);
            }
        }
        throw new Error('TTS generation failed');
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

/**
 * Speech-to-Text using HuggingFace (Whisper)
 */
export async function transcribeAudio(options) {
    const {
        apiKey,
        model = 'openai/whisper-large-v3',
        audioBlob
    } = options;

    if (!apiKey) {
        throw new Error('HuggingFace API key is required');
    }

    const response = await fetch(`${HF_INFERENCE_BASE}/${model}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`
        },
        body: audioBlob
    });

    if (!response.ok) {
        throw new Error('Transcription failed');
    }

    const data = await response.json();
    return data.text;
}

// ============================================
// RECOMMENDED MODELS
// ============================================

export const RECOMMENDED_MODELS = {
    codeGeneration: [
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'openrouter' },
        { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', provider: 'openrouter' },
        { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter' },
        { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro', provider: 'openrouter' },
        { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', provider: 'openrouter' }
    ],
    imageGeneration: [
        { id: 'stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL', provider: 'huggingface' },
        { id: 'black-forest-labs/FLUX.1-dev', name: 'FLUX.1', provider: 'huggingface' },
        { id: 'playgroundai/playground-v2.5-1024px-aesthetic', name: 'Playground v2.5', provider: 'huggingface' }
    ],
    tts: [
        { id: 'facebook/mms-tts-eng', name: 'MMS TTS (English)', provider: 'huggingface' },
        { id: 'suno/bark', name: 'Bark (Multi-voice)', provider: 'huggingface' },
        { id: 'microsoft/speecht5_tts', name: 'SpeechT5', provider: 'huggingface' }
    ],
    stt: [
        { id: 'openai/whisper-large-v3', name: 'Whisper Large v3', provider: 'huggingface' },
        { id: 'openai/whisper-medium', name: 'Whisper Medium', provider: 'huggingface' }
    ]
};

// ============================================
// UNIFIED GENERATION INTERFACE
// ============================================

/**
 * Generate website code using the configured AI provider
 */
export async function generateWebsite(options) {
    const {
        prompt,
        currentFiles = [],
        apiKey,
        model,
        systemPrompt
    } = options;

    const messages = [
        {
            role: 'system',
            content: systemPrompt || `You are an expert web developer. Generate clean, modern HTML, CSS, and JavaScript code.

When given a prompt, create a complete, functional website.
Output your response as a JSON object with this structure:
{
    "files": [
        {"path": "index.html", "content": "..."},
        {"path": "styles.css", "content": "..."},
        {"path": "script.js", "content": "..."}
    ],
    "description": "Brief description of what was created/changed"
}`
        },
        ...(currentFiles.length > 0 ? [{
            role: 'user',
            content: `Current project files:\n${JSON.stringify(currentFiles, null, 2)}`
        }] : []),
        {
            role: 'user',
            content: prompt
        }
    ];

    const response = await generateWithOpenRouter({
        apiKey,
        model,
        messages,
        jsonMode: true
    });

    try {
        return JSON.parse(response);
    } catch {
        // If JSON parsing fails, try to extract JSON from markdown code blocks
        const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[1]);
        }
        throw new Error('Failed to parse AI response as JSON');
    }
}

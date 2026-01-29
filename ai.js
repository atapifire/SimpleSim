import { state } from './state.js';
import { security } from './security.js';
import { showToast } from './utils.js';

// Timeout for API requests (2 minutes)
const API_TIMEOUT = 120000;

export async function generateProject(prompt, currentFiles) {
    const systemPrompt = `
You are an expert Frontend Developer. Your task is to generate or modify a static website based on the user's prompt.

CONTEXT:
${currentFiles ? "You are modifying an existing project. I will provide the current files. Please update them to fulfill the request. Maintain existing functionality unless asked to change it." : "You are creating a brand new project from scratch."}

OUTPUT FORMAT:
Return strictly valid JSON with no markdown formatting. The JSON must match this schema:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." },
    { "path": "script.js", "content": "..." }
  ],
  "description": "A very brief summary of changes (max 10 words)"
}

REQUIREMENTS:
- Use semantic HTML5.
- Use modern CSS (Flexbox, Grid). You can use 'https://cdn.tailwindcss.com' in the HTML <head> if you want, or write custom CSS.
- Use vanilla JavaScript.
- Images: Use 'https://source.unsplash.com/random/800x600?keyword' (replace keyword) or placeholder colors.
- If modifying, keep the file structure.
- Ensure the design is mobile-responsive.
- Add basic error handling in JS.

USER PROMPT: ${prompt}
    `;

    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    if (currentFiles) {
        const contextStr = JSON.stringify(currentFiles);
        const safeContext = contextStr.length > 50000 ? contextStr.substring(0, 50000) + "...(truncated)" : contextStr;
        messages.splice(1, 0, {
            role: "user",
            content: `CURRENT FILES:\n${safeContext}\n\nINSTRUCTIONS: Modify these files based on: "${prompt}"`
        });
    }

    // Always use OpenRouter (BYOK model)
    return await generateWithOpenRouter(messages);
}

async function generateWithOpenRouter(messages) {
    const key = security.getKey();
    if (!key) throw new Error("OpenRouter Key Locked or Missing");

    console.log('[AI] Starting generation with model:', state.settings.openRouterModel);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        console.error('[AI] Request timed out');
    }, API_TIMEOUT);

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": window.location.origin,
                "X-Title": "SimpleSim"
            },
            body: JSON.stringify({
                model: state.settings.openRouterModel,
                messages: messages,
                response_format: { type: "json_object" }
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        console.log('[AI] Response status:', response.status);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error('[AI] API Error:', err);
            throw new Error(`OpenRouter Error: ${err.error?.message || response.statusText}`);
        }

        const data = await response.json();
        console.log('[AI] Response received, parsing...');

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error('Empty response from AI');
        }

        // Try to parse JSON, handle markdown code blocks
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            // Try extracting from markdown code block
            const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[1]);
            } else {
                console.error('[AI] Failed to parse response:', content.substring(0, 500));
                throw new Error('Failed to parse AI response as JSON');
            }
        }

        console.log('[AI] Generation complete');
        return parsed;

    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            throw new Error('Request timed out - try a simpler prompt or different model');
        }
        throw error;
    }
}

/**
 * Check OpenRouter API key credits
 */
export async function checkCredits() {
    const key = security.getKey();
    if (!key) return null;

    try {
        const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
            headers: { "Authorization": `Bearer ${key}` }
        });

        if (!response.ok) return null;

        const data = await response.json();
        return {
            credits: data.data?.limit || 0,
            usage: data.data?.usage || 0,
            remaining: (data.data?.limit || 0) - (data.data?.usage || 0),
            isFreeTier: (data.data?.limit || 0) === 0
        };
    } catch (e) {
        console.error('[AI] Failed to check credits:', e);
        return null;
    }
}

/**
 * Fetch models, optionally filtered by free tier
 */
export async function fetchModelsWithCredits() {
    const key = security.getKey();
    if (!key) return [];

    try {
        const [modelsRes, creditsInfo] = await Promise.all([
            fetch("https://openrouter.ai/api/v1/models", {
                headers: { "Authorization": `Bearer ${key}` }
            }),
            checkCredits()
        ]);

        if (!modelsRes.ok) return [];

        const modelsData = await modelsRes.json();
        let models = modelsData.data || [];

        // If free tier (no credits), filter to free models only
        if (creditsInfo?.isFreeTier) {
            models = models.filter(m =>
                m.pricing?.prompt === "0" ||
                m.pricing?.prompt === 0 ||
                m.id.includes(':free')
            );
            console.log('[AI] Free tier detected, showing', models.length, 'free models');
        }

        return models.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        console.error('[AI] Failed to fetch models:', e);
        return [];
    }
}
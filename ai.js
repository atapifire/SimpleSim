import { state } from './state.js';
import { security } from './security.js';
import { thinking, devLog, devError } from './thinking.js';

// Timeout for API requests (3 minutes for streaming)
const API_TIMEOUT = 180000;

export async function generateProject(prompt, currentFiles) {
    const systemPrompt = `You are an expert Frontend Developer. Generate or modify a static website based on the user's prompt.

CONTEXT: ${currentFiles ? "Modifying existing project. Update files to fulfill the request while maintaining existing functionality." : "Creating a new project from scratch."}

OUTPUT FORMAT - Return ONLY valid JSON (no markdown, no code blocks):
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    { "path": "styles.css", "content": "..." },
    { "path": "script.js", "content": "..." }
  ],
  "description": "Brief summary (max 10 words)"
}

REQUIREMENTS:
- Always include index.html as the entry point
- Use semantic HTML5
- Use Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
- Use vanilla JavaScript in script.js
- Images: Use https://picsum.photos/800/600 or placeholder divs
- Make it mobile-responsive
- Keep code clean and well-structured`;

    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    if (currentFiles) {
        const contextStr = JSON.stringify(currentFiles);
        const safeContext = contextStr.length > 30000 ? contextStr.substring(0, 30000) + "...(truncated)" : contextStr;
        messages.splice(1, 0, {
            role: "user",
            content: `CURRENT FILES:\n${safeContext}\n\nMODIFY based on: "${prompt}"`
        });
    }

    return await generateWithOpenRouter(messages);
}

async function generateWithOpenRouter(messages) {
    const key = security.getKey();
    if (!key) throw new Error("OpenRouter Key Locked or Missing");

    thinking.show();
    thinking.setStatus('thinking', `Connecting to ${state.settings.openRouterModel}...`);

    devLog('Starting generation with model:', state.settings.openRouterModel);
    devLog('Messages:', messages.length, 'total');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        devError('Request timed out after', API_TIMEOUT / 1000, 'seconds');
    }, API_TIMEOUT);

    try {
        thinking.setStatus('generating', 'Sending request to AI model...');

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
                stream: true
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            devError('API Error:', response.status, err);
            thinking.setStatus('error', `API Error: ${err.error?.message || response.statusText}`);
            throw new Error(`OpenRouter Error: ${err.error?.message || response.statusText}`);
        }

        thinking.setStatus('generating', 'Receiving response...');
        thinking.clearStream();

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let chunkCount = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            fullContent += content;
                            chunkCount++;

                            // Stream code to thinking UI (shows scrolling code)
                            thinking.streamCode(content);

                            // Log progress periodically
                            if (chunkCount % 50 === 0) {
                                thinking.log('stream', `${fullContent.length} chars received...`);
                            }
                        }
                    } catch (e) {
                        // Skip malformed chunks
                    }
                }
            }
        }

        devLog('Streaming complete, total content:', fullContent.length, 'chars');
        thinking.setStatus('parsing', 'Parsing response...');

        if (!fullContent) {
            thinking.setStatus('error', 'Empty response from AI');
            throw new Error('Empty response from AI');
        }

        // Parse JSON response
        let parsed;
        try {
            // Try direct JSON parse first
            parsed = JSON.parse(fullContent);
        } catch (e) {
            devLog('Direct parse failed, trying to extract JSON...');

            // Try to extract JSON from markdown code blocks
            const jsonMatch = fullContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[1]);
            } else {
                // Try to find JSON object in the response
                const jsonStart = fullContent.indexOf('{');
                const jsonEnd = fullContent.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    parsed = JSON.parse(fullContent.slice(jsonStart, jsonEnd + 1));
                } else {
                    devError('Failed to parse response:', fullContent.substring(0, 500));
                    thinking.setStatus('error', 'Failed to parse AI response');
                    throw new Error('Failed to parse AI response as JSON');
                }
            }
        }

        // Validate response structure
        if (!parsed.files || !Array.isArray(parsed.files)) {
            thinking.setStatus('error', 'Invalid response structure');
            throw new Error('Response missing files array');
        }

        // Ensure index.html exists
        const hasIndex = parsed.files.some(f => f.path === 'index.html');
        if (!hasIndex) {
            thinking.setStatus('error', 'No index.html in response');
            throw new Error('Generated project must have index.html');
        }

        thinking.setStatus('complete', `Generated ${parsed.files.length} files`);
        devLog('Generation complete:', parsed.files.map(f => f.path));

        // Hide thinking after a short delay
        setTimeout(() => thinking.hide(), 2000);

        return parsed;

    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            thinking.setStatus('error', 'Request timed out');
            throw new Error('Request timed out - try a simpler prompt or different model');
        }

        thinking.setStatus('error', error.message);
        devError('Generation failed:', error);
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
        devLog('Credits info:', data.data);

        return {
            credits: data.data?.limit || 0,
            usage: data.data?.usage || 0,
            remaining: (data.data?.limit || 0) - (data.data?.usage || 0),
            isFreeTier: (data.data?.limit || 0) === 0
        };
    } catch (e) {
        devError('Failed to check credits:', e);
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
            devLog('Free tier detected, showing', models.length, 'free models');
        }

        return models.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        devError('Failed to fetch models:', e);
        return [];
    }
}

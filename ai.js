import { state } from './state.js';
import { security } from './security.js';
import { thinking, devLog, devError } from './thinking.js';

// Timeout for API requests (3 minutes for streaming)
const API_TIMEOUT = 180000;

/**
 * Generate or update a project based on user prompt
 */
export async function generateProject(prompt, currentFiles) {
    const isRevision = currentFiles && Array.isArray(currentFiles) && currentFiles.length > 0;

    devLog('Generation mode:', isRevision ? 'REVISION' : 'NEW PROJECT');
    devLog('Current files:', currentFiles?.map(f => f.path) || 'none');

    const systemPrompt = isRevision
        ? buildRevisionPrompt(currentFiles)
        : buildNewProjectPrompt();

    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    // For revisions, include current files context efficiently
    if (isRevision) {
        const fileContext = buildFileContext(currentFiles);
        messages.splice(1, 0, {
            role: "user",
            content: fileContext
        });
    }

    const result = await generateWithOpenRouter(messages);

    // For revisions, merge changes with existing files
    if (isRevision && result.files) {
        result.files = mergeFiles(currentFiles, result.files);
        devLog('Merged files:', result.files.map(f => f.path));
    }

    return result;
}

/**
 * Build system prompt for new projects
 */
function buildNewProjectPrompt() {
    return `You are an expert Frontend Developer. Create a complete static website.

OUTPUT FORMAT - Return ONLY valid JSON (no markdown, no code blocks):
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    { "path": "styles.css", "content": "/* CSS */" },
    { "path": "script.js", "content": "// JavaScript" }
  ],
  "description": "Brief description (max 10 words)"
}

REQUIREMENTS:
- Always include index.html as entry point
- Use Tailwind CSS: <script src="https://cdn.tailwindcss.com"></script>
- Write clean, semantic HTML5
- Use vanilla JavaScript
- Images: https://picsum.photos/WIDTH/HEIGHT or placeholder divs
- Make it mobile-responsive
- Include basic interactivity where appropriate`;
}

/**
 * Build system prompt for revisions - optimized for partial updates
 */
function buildRevisionPrompt(currentFiles) {
    const fileList = currentFiles.map(f => `- ${f.path} (${f.content.length} chars)`).join('\n');

    return `You are an expert Frontend Developer. Modify an existing website based on the user's request.

CURRENT PROJECT FILES:
${fileList}

OUTPUT FORMAT - Return ONLY valid JSON:
{
  "files": [
    { "path": "filename.ext", "content": "full file content", "action": "modify" }
  ],
  "description": "Brief description of changes"
}

IMPORTANT RULES:
1. Only include files that need to be CHANGED or ADDED
2. Do NOT include unchanged files
3. For each file, specify action: "modify", "add", or "delete"
4. For "delete" action, content can be empty
5. Return the COMPLETE new content for modified files (not diffs)
6. Preserve existing functionality unless asked to change it
7. Keep the same file structure when possible

EXAMPLE - If user asks to "change the header color to blue":
{
  "files": [
    { "path": "styles.css", "content": "/* updated CSS with blue header */...", "action": "modify" }
  ],
  "description": "Changed header color to blue"
}`;
}

/**
 * Build efficient file context for the model
 */
function buildFileContext(files) {
    // For small projects, include full content
    const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);

    if (totalSize < 20000) {
        // Include full files for small projects
        const fileContents = files.map(f =>
            `=== ${f.path} ===\n${f.content}`
        ).join('\n\n');

        return `CURRENT PROJECT FILES:\n\n${fileContents}\n\nModify these files based on my request below.`;
    }

    // For larger projects, include structure + key file excerpts
    devLog('Large project detected, using summarized context');

    let context = 'CURRENT PROJECT STRUCTURE:\n\n';

    for (const file of files) {
        context += `=== ${file.path} (${file.content.length} chars) ===\n`;

        if (file.path === 'index.html') {
            // Include HTML structure
            context += file.content.substring(0, 2000);
            if (file.content.length > 2000) context += '\n... (truncated)';
        } else if (file.path === 'styles.css') {
            // Include first part of CSS
            context += file.content.substring(0, 1500);
            if (file.content.length > 1500) context += '\n... (truncated)';
        } else if (file.path === 'script.js') {
            // Include JS structure
            context += file.content.substring(0, 1500);
            if (file.content.length > 1500) context += '\n... (truncated)';
        } else {
            // Other files - just show beginning
            context += file.content.substring(0, 500);
            if (file.content.length > 500) context += '\n... (truncated)';
        }
        context += '\n\n';
    }

    return context + 'Modify these files based on my request. Return COMPLETE file contents for any file you change.';
}

/**
 * Merge AI response files with existing files
 * - Modified files replace existing
 * - Added files are appended
 * - Deleted files are removed
 * - Unchanged files are preserved
 */
function mergeFiles(existingFiles, newFiles) {
    const result = [...existingFiles];

    for (const newFile of newFiles) {
        const action = newFile.action || 'modify';
        const existingIndex = result.findIndex(f => f.path === newFile.path);

        if (action === 'delete') {
            if (existingIndex !== -1) {
                result.splice(existingIndex, 1);
                devLog(`Deleted: ${newFile.path}`);
            }
        } else if (action === 'add' || existingIndex === -1) {
            // New file
            result.push({ path: newFile.path, content: newFile.content });
            devLog(`Added: ${newFile.path}`);
        } else {
            // Modify existing file
            result[existingIndex] = { path: newFile.path, content: newFile.content };
            devLog(`Modified: ${newFile.path}`);
        }
    }

    return result;
}

/**
 * Make streaming API call to OpenRouter
 */
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

                            // Stream code to thinking UI
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

        // Parse JSON response with multiple fallback strategies
        const parsed = parseAIResponse(fullContent);

        // Validate response structure
        if (!parsed.files || !Array.isArray(parsed.files)) {
            thinking.setStatus('error', 'Invalid response structure');
            throw new Error('Response missing files array');
        }

        // Ensure index.html exists (for new projects)
        const hasIndex = parsed.files.some(f => f.path === 'index.html');
        if (!hasIndex && parsed.files.some(f => f.action !== 'delete')) {
            // Check if this is a revision that doesn't touch index.html
            devLog('No index.html in response - this may be a partial update');
        }

        thinking.setStatus('complete', `Generated ${parsed.files.length} file(s)`);
        devLog('Generation complete:', parsed.files.map(f => `${f.path} (${f.action || 'modify'})`));

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
 * Parse AI response with multiple fallback strategies
 */
function parseAIResponse(content) {
    // Strategy 1: Direct JSON parse
    try {
        return JSON.parse(content);
    } catch (e) {
        devLog('Direct JSON parse failed, trying fallbacks...');
    }

    // Strategy 2: Extract from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[1]);
        } catch (e) {
            devLog('Markdown extraction failed');
        }
    }

    // Strategy 3: Find JSON object boundaries
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        try {
            return JSON.parse(content.slice(jsonStart, jsonEnd + 1));
        } catch (e) {
            devLog('JSON boundary extraction failed');
        }
    }

    // Strategy 4: Try to fix common JSON issues
    try {
        // Remove potential trailing commas and fix quotes
        let fixed = content
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']')
            .replace(/'/g, '"');
        return JSON.parse(fixed);
    } catch (e) {
        devLog('JSON fix attempt failed');
    }

    devError('All JSON parsing strategies failed');
    devError('Response preview:', content.substring(0, 500));
    throw new Error('Failed to parse AI response as JSON');
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

import { state } from './state.js';
import { security } from './security.js';
import { thinking, devLog, devError } from './thinking.js';
import { analyzeProjectHealth, generateCodeMap, estimateTokens, formatTokenCount, buildRefactoringPrompt } from './tokens.js';

// Timeout for API requests (3 minutes for streaming)
const API_TIMEOUT = 180000;

// Token thresholds for edit strategies
const SMALL_PROJECT_TOKENS = 8000;   // Full content for small projects
const MEDIUM_PROJECT_TOKENS = 20000; // Summarized for medium
// Above MEDIUM = code map only

/**
 * Generate or update a project based on user prompt
 */
export async function generateProject(prompt, currentFiles) {
    const isRevision = currentFiles && Array.isArray(currentFiles) && currentFiles.length > 0;
    const health = isRevision ? analyzeProjectHealth(currentFiles) : null;

    devLog('Generation mode:', isRevision ? 'REVISION' : 'NEW PROJECT');
    if (health) {
        devLog('Project health:', health.status, `(${formatTokenCount(health.totalTokens)} tokens)`);
    }

    // Choose the optimal prompt strategy based on project size
    const systemPrompt = isRevision
        ? buildRevisionPrompt(currentFiles, health)
        : buildNewProjectPrompt();

    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    // For revisions, include context based on project size
    if (isRevision) {
        const fileContext = buildOptimalContext(currentFiles, health);
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
 * Request AI to refactor a large file into smaller ones
 */
export async function refactorLargeFile(files, targetFile) {
    const prompt = buildRefactoringPrompt(files, targetFile);
    if (!prompt) {
        throw new Error(`File ${targetFile} not found`);
    }

    const messages = [
        {
            role: "system",
            content: `You are an expert at code organization and refactoring.
Your task is to split a large file into smaller, well-organized modules.

OUTPUT FORMAT - Return ONLY valid JSON:
{
  "files": [
    { "path": "newfile.js", "content": "...", "action": "add" },
    { "path": "oldfile.js", "content": "", "action": "delete" }
  ],
  "description": "Split into X smaller modules"
}

RULES:
1. Create 2-4 new focused files
2. Each file should have a single responsibility
3. Preserve all functionality
4. Use clear, descriptive file names
5. Update imports/exports as needed`
        },
        { role: "user", content: prompt }
    ];

    return await generateWithOpenRouter(messages);
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
- Include basic interactivity where appropriate
- Keep files under 200 lines each when possible`;
}

/**
 * Build system prompt for revisions - uses efficient edit format
 */
function buildRevisionPrompt(currentFiles, health) {
    const fileList = currentFiles.map(f => {
        const tokens = estimateTokens(f.content);
        const status = tokens >= 5000 ? ' ⚠️ LARGE' : '';
        return `- ${f.path} (${formatTokenCount(tokens)} tokens)${status}`;
    }).join('\n');

    // Use search/replace format for efficiency (inspired by Aider)
    return `You are an expert Frontend Developer. Modify an existing website based on the user's request.

PROJECT FILES:
${fileList}
Total: ${formatTokenCount(health.totalTokens)} tokens

OUTPUT FORMAT - Return ONLY valid JSON:
{
  "files": [
    {
      "path": "filename.ext",
      "content": "complete new file content",
      "action": "modify"
    }
  ],
  "description": "Brief description of changes"
}

EFFICIENCY RULES:
1. Only return files that CHANGE - never include unchanged files
2. Actions: "modify" (update), "add" (new file), "delete" (remove)
3. Return COMPLETE file content for modified files
4. For small changes, still return the full file content
5. Preserve existing functionality unless asked to change

FILE SIZE GUIDANCE:
- If a file is marked ⚠️ LARGE, consider splitting it when making changes
- Keep individual files under 200 lines when practical
- Split by responsibility: layout, components, utilities, etc.

EXAMPLE for "change button color to blue":
{
  "files": [
    { "path": "styles.css", "content": "/* full updated CSS */", "action": "modify" }
  ],
  "description": "Changed button color to blue"
}`;
}

/**
 * Build optimal context based on project size
 */
function buildOptimalContext(files, health) {
    const totalTokens = health.totalTokens;

    // Small projects: include everything
    if (totalTokens < SMALL_PROJECT_TOKENS) {
        devLog('Using FULL context strategy');
        return buildFullContext(files);
    }

    // Medium projects: summarized with key excerpts
    if (totalTokens < MEDIUM_PROJECT_TOKENS) {
        devLog('Using SUMMARIZED context strategy');
        return buildSummarizedContext(files);
    }

    // Large projects: code map only
    devLog('Using CODE MAP context strategy');
    return buildCodeMapContext(files);
}

/**
 * Full context - include all file contents
 */
function buildFullContext(files) {
    const fileContents = files.map(f =>
        `=== ${f.path} ===\n${f.content}`
    ).join('\n\n');

    return `CURRENT PROJECT FILES:\n\n${fileContents}\n\nApply the requested changes to these files.`;
}

/**
 * Summarized context - truncate large files
 */
function buildSummarizedContext(files) {
    let context = 'CURRENT PROJECT (summarized for large files):\n\n';

    for (const file of files) {
        const tokens = estimateTokens(file.content);
        context += `=== ${file.path} (${formatTokenCount(tokens)} tokens) ===\n`;

        if (tokens < 2000) {
            // Include full content for smaller files
            context += file.content;
        } else {
            // Truncate larger files with smart excerpts
            const lines = file.content.split('\n');
            const headLines = lines.slice(0, 50).join('\n');
            const tailLines = lines.slice(-20).join('\n');

            context += headLines;
            context += `\n\n... [${lines.length - 70} lines omitted] ...\n\n`;
            context += tailLines;
        }
        context += '\n\n';
    }

    return context + 'Apply the requested changes. Return COMPLETE file content for any file you modify.';
}

/**
 * Code map context - structure only, minimal content
 */
function buildCodeMapContext(files) {
    const codeMap = generateCodeMap(files);

    // Still include the most relevant file fully if it's small
    const smallFiles = files.filter(f => estimateTokens(f.content) < 1500);
    let relevantContent = '';

    if (smallFiles.length > 0) {
        const mainFile = smallFiles.find(f => f.path === 'index.html') || smallFiles[0];
        relevantContent = `\n\nMAIN FILE CONTENT:\n=== ${mainFile.path} ===\n${mainFile.content}`;
    }

    return `${codeMap}${relevantContent}\n\nThis is a LARGE project. I've provided the structure and key file.
When you make changes, return COMPLETE file content for modified files.
If you need to see a specific file's full content, ask me to provide it.`;
}

/**
 * Merge AI response files with existing files
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
            result.push({ path: newFile.path, content: newFile.content });
            devLog(`Added: ${newFile.path}`);
        } else {
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
    let timeoutId = null;
    let lastActivityTime = Date.now();

    // Streaming timeout - abort if no data received for 60 seconds
    const STREAM_INACTIVITY_TIMEOUT = 60000;

    const resetStreamTimeout = () => {
        lastActivityTime = Date.now();
    };

    // Initial connection timeout
    timeoutId = setTimeout(() => {
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

        // Clear initial timeout, set up streaming inactivity check
        clearTimeout(timeoutId);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            devError('API Error:', response.status, err);
            thinking.setStatus('error', `API Error: ${err.error?.message || response.statusText}`);
            throw new Error(`OpenRouter Error: ${err.error?.message || response.statusText}`);
        }

        thinking.setStatus('generating', 'Receiving response...');
        thinking.clearStream();

        // Handle streaming response with inactivity timeout
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let chunkCount = 0;

        // Set up inactivity checker
        const inactivityChecker = setInterval(() => {
            if (Date.now() - lastActivityTime > STREAM_INACTIVITY_TIMEOUT) {
                devError('Stream inactivity timeout - no data for 60 seconds');
                controller.abort();
                clearInterval(inactivityChecker);
            }
        }, 5000);

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                resetStreamTimeout(); // Reset on any data received

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
                                thinking.streamCode(content);

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
        } finally {
            clearInterval(inactivityChecker);
        }

        devLog('Streaming complete, total content:', fullContent.length, 'chars');

        // If streaming returned empty, try non-streaming fallback
        if (!fullContent || fullContent.length === 0) {
            devLog('Streaming returned empty, trying non-streaming fallback...');
            thinking.setStatus('generating', 'Retrying without streaming...');

            const fallbackResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
                    stream: false
                })
            });

            if (!fallbackResponse.ok) {
                const err = await fallbackResponse.json().catch(() => ({}));
                thinking.setStatus('error', `Fallback failed: ${err.error?.message || fallbackResponse.statusText}`);
                throw new Error(`OpenRouter Error: ${err.error?.message || fallbackResponse.statusText}`);
            }

            const fallbackData = await fallbackResponse.json();
            fullContent = fallbackData.choices?.[0]?.message?.content || '';
            devLog('Fallback response:', fullContent.length, 'chars');

            if (fullContent) {
                thinking.streamCode(fullContent);
            }
        }

        thinking.setStatus('parsing', 'Parsing response...');

        if (!fullContent) {
            thinking.setStatus('error', 'Empty response from AI');
            throw new Error('Empty response from AI - model returned no content');
        }

        const parsed = parseAIResponse(fullContent);

        if (!parsed.files || !Array.isArray(parsed.files)) {
            thinking.setStatus('error', 'Invalid response structure');
            throw new Error('Response missing files array');
        }

        // Validate files have content
        if (parsed.files.length === 0) {
            thinking.setStatus('error', 'No files in response');
            throw new Error('AI returned empty files array');
        }

        thinking.setStatus('complete', `Generated ${parsed.files.length} file(s)`);
        devLog('Generation complete:', parsed.files.map(f => `${f.path} (${f.action || 'modify'})`));

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
 * Enhanced to handle various model output formats
 */
function parseAIResponse(content) {
    devLog('Parsing response, length:', content.length);

    // Strategy 1: Direct JSON parse (cleanest case)
    try {
        const result = JSON.parse(content);
        if (validateParsedResult(result)) return result;
    } catch (e) {
        devLog('Direct JSON parse failed, trying fallbacks...');
    }

    // Strategy 2: Extract from markdown code blocks (```json ... ```)
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        try {
            const result = JSON.parse(jsonBlockMatch[1]);
            if (validateParsedResult(result)) return result;
        } catch (e) {
            devLog('Markdown extraction failed');
        }
    }

    // Strategy 3: Find JSON object with "files" array (most reliable for our format)
    const filesPattern = /"files"\s*:\s*\[/;
    const filesMatch = content.match(filesPattern);
    if (filesMatch) {
        // Find the starting brace before "files"
        const beforeFiles = content.substring(0, filesMatch.index);
        const startBrace = beforeFiles.lastIndexOf('{');
        if (startBrace !== -1) {
            // Find matching end brace
            let depth = 0;
            let endBrace = -1;
            for (let i = startBrace; i < content.length; i++) {
                if (content[i] === '{') depth++;
                else if (content[i] === '}') {
                    depth--;
                    if (depth === 0) {
                        endBrace = i;
                        break;
                    }
                }
            }
            if (endBrace !== -1) {
                try {
                    const result = JSON.parse(content.slice(startBrace, endBrace + 1));
                    if (validateParsedResult(result)) return result;
                } catch (e) {
                    devLog('Files pattern extraction failed');
                }
            }
        }
    }

    // Strategy 4: Find outermost JSON object boundaries
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        try {
            const result = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
            if (validateParsedResult(result)) return result;
        } catch (e) {
            devLog('JSON boundary extraction failed');
        }
    }

    // Strategy 5: Fix common JSON issues
    let fixedContent = content;
    try {
        // Extract potential JSON first
        if (jsonStart !== -1 && jsonEnd !== -1) {
            fixedContent = content.slice(jsonStart, jsonEnd + 1);
        }

        // Fix common issues
        fixedContent = fixedContent
            .replace(/,\s*}/g, '}')           // Trailing commas before }
            .replace(/,\s*]/g, ']')           // Trailing commas before ]
            .replace(/'/g, '"')               // Single quotes to double
            .replace(/\n/g, '\\n')            // Escape newlines in strings
            .replace(/\t/g, '\\t')            // Escape tabs
            .replace(/\r/g, '\\r')            // Escape carriage returns
            .replace(/\\(?!["\\/bfnrtu])/g, '\\\\'); // Escape unescaped backslashes

        const result = JSON.parse(fixedContent);
        if (validateParsedResult(result)) return result;
    } catch (e) {
        devLog('JSON fix attempt failed');
    }

    // Strategy 6: Try to extract files array directly and construct response
    try {
        const filesArrayMatch = content.match(/\[\s*\{[\s\S]*?"path"\s*:/);
        if (filesArrayMatch) {
            const arrayStart = content.indexOf('[', filesArrayMatch.index);
            let depth = 0;
            let arrayEnd = -1;
            for (let i = arrayStart; i < content.length; i++) {
                if (content[i] === '[') depth++;
                else if (content[i] === ']') {
                    depth--;
                    if (depth === 0) {
                        arrayEnd = i;
                        break;
                    }
                }
            }
            if (arrayEnd !== -1) {
                const filesArray = JSON.parse(content.slice(arrayStart, arrayEnd + 1));
                if (Array.isArray(filesArray) && filesArray.length > 0) {
                    devLog('Extracted files array directly');
                    return {
                        files: filesArray,
                        description: 'Generated content'
                    };
                }
            }
        }
    } catch (e) {
        devLog('Direct files array extraction failed');
    }

    devError('All JSON parsing strategies failed');
    devError('Response preview:', content.substring(0, 500));
    throw new Error('Failed to parse AI response as JSON');
}

/**
 * Validate that parsed result has required structure
 */
function validateParsedResult(result) {
    if (!result || typeof result !== 'object') return false;
    if (!result.files || !Array.isArray(result.files)) return false;
    if (result.files.length === 0) return false;

    // Check that at least one file has path and content
    const hasValidFile = result.files.some(f => f.path && typeof f.content === 'string');
    return hasValidFile;
}

/**
 * Check OpenRouter API key credits
 *
 * OpenRouter API returns:
 * - limit: null = unlimited (paid with no cap)
 * - limit: 0 = no credits / free tier
 * - limit: >0 = credit limit in cents
 * - usage: current usage in cents
 * - is_free_tier: boolean (if provided by API)
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
        devLog('Credits API response:', JSON.stringify(data.data, null, 2));

        const limit = data.data?.limit;
        const usage = data.data?.usage || 0;
        const apiSaysFreeTier = data.data?.is_free_tier;

        // Use API's is_free_tier if explicitly provided
        // Otherwise fall back to limit-based detection
        let isFreeTier;
        if (typeof apiSaysFreeTier === 'boolean') {
            // Trust the API's explicit free tier indicator
            isFreeTier = apiSaysFreeTier;
        } else {
            // Fallback: limit of 0 with no usage suggests free tier
            isFreeTier = limit === 0 && usage === 0;
        }

        devLog('Credit detection:', { limit, usage, apiSaysFreeTier, isFreeTier });

        return {
            credits: limit ?? 0,
            usage: usage,
            remaining: limit !== null ? Math.max(0, limit - usage) : Infinity,
            isFreeTier: isFreeTier,
            isUnlimited: limit === null && !isFreeTier
        };
    } catch (e) {
        devError('Failed to check credits:', e);
        return null;
    }
}

/**
 * Cache for model tool support (populated from API response)
 * Key: model ID, Value: 'full' | 'partial' | 'none'
 */
const modelToolSupportCache = new Map();

/**
 * Detect if a model supports tool calling from API response
 * OpenRouter returns supported_parameters array - ONLY "tools" indicates tool support
 * "tool_choice" alone does NOT mean tool support
 */
function detectToolSupport(model) {
    const supportedParams = model.supported_parameters || [];

    // ONLY check for "tools" in supported_parameters - this is the definitive check
    // "tool_choice" alone doesn't mean tool support (some models have it but can't use tools)
    let support = 'none';
    if (supportedParams.includes('tools')) {
        support = 'full';
    }

    // Cache the result for runtime checks
    if (model.id) {
        modelToolSupportCache.set(model.id, support);
    }

    return support;
}

/**
 * Fetch models with capability information
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

        if (!modelsRes.ok) {
            devError('Models API error:', modelsRes.status, modelsRes.statusText);
            return [];
        }

        const modelsData = await modelsRes.json();
        let models = modelsData.data || [];
        devLog('Total models from API:', models.length);

        // Enrich models with tool support info
        models = models.map(m => ({
            ...m,
            toolSupport: detectToolSupport(m),
            isFree: m.pricing?.prompt === "0" || m.pricing?.prompt === 0 ||
                    String(m.pricing?.prompt) === "0" || m.id.includes(':free')
        }));

        // Log tool support stats
        const toolModels = models.filter(m => m.toolSupport === 'full');
        const toolStats = {
            full: toolModels.length,
            none: models.filter(m => m.toolSupport === 'none').length,
            cached: modelToolSupportCache.size
        };
        devLog('Tool support stats:', toolStats);
        devLog('Models with tool support:', toolModels.map(m => m.id).slice(0, 10), '...');

        if (creditsInfo?.isFreeTier) {
            const beforeFilter = models.length;
            models = models.filter(m => m.isFree);
            devLog(`Free tier: filtered ${beforeFilter} → ${models.length} free models`);
        } else {
            devLog('Paid tier or unlimited: showing all', models.length, 'models');
        }

        return models.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
        devError('Failed to fetch models:', e);
        return [];
    }
}

/**
 * Check if a model ID supports tool calling
 * Used by agent.js to validate model before running
 *
 * Priority:
 * 1. Check cache (populated from API response)
 * 2. Free models (:free) → always 'none'
 * 3. Unknown → assume 'none' for safety
 */
export function checkModelToolSupport(modelId) {
    if (!modelId) return 'none';

    // Check cache first (populated when models are fetched)
    if (modelToolSupportCache.has(modelId)) {
        return modelToolSupportCache.get(modelId);
    }

    // Free models never support tools
    if (modelId.toLowerCase().includes(':free')) {
        return 'none';
    }

    // Unknown model - assume no support for safety
    // User should select a model from the dropdown to get accurate detection
    devLog(`Model ${modelId} not in cache - assuming no tool support`);
    return 'none';
}

// Re-export for use in other modules
export { analyzeProjectHealth, formatTokenCount } from './tokens.js';

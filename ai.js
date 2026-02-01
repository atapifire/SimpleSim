import { state } from './state.js';
import { security } from './security.js';
import { thinking, devLog, devError } from './thinking.js';
import { analyzeProjectHealth, generateCodeMap, estimateTokens, formatTokenCount, buildRefactoringPrompt } from './tokens.js';
import { getApiKey } from './job-queue.js';
import {
    getModelProfile,
    getModelFamily,
    getContextLimit,
    getPromptStyle,
    getJsonReliability,
    prefersEditFormat
} from './model-profiles.js';
import {
    FILE_ACTIONS,
    applyEdits,
    validateEdits,
    mergeWithEdits,
    validateFileSyntax,
    validateGenerationResult,
    validateAndRepairFiles,
    validateAndRepairHTML,
    detectTruncation
} from './file-ops.js';
import {
    PROTOCOL_DATA,
    TECHNICAL_GUIDELINES,
    getLibraryInstructions,
    enhancePromptWithProtocol
} from './protocol-data.js';
import {
    buildNewProjectSystemPrompt,
    buildRevisionSystemPrompt,
    buildNewProjectUserMessage,
    buildRevisionUserMessage,
    VERIFICATION_CHECKLIST,
    getModelSpecificInstructions
} from './prompts.js';

// Timeout for API requests (3 minutes for streaming)
const API_TIMEOUT = 180000;

// Token thresholds for context strategies (can be overridden by model profile)
const DEFAULT_SMALL_PROJECT_TOKENS = 8000;   // Full content for small projects
const DEFAULT_MEDIUM_PROJECT_TOKENS = 20000; // Summarized for medium
const DEFAULT_LARGE_PROJECT_TOKENS = 50000;  // Selective context for very large
// Above LARGE = selective context only

/**
 * Generate or update a project based on user prompt
 */
export async function generateProject(prompt, currentFiles) {
    const isRevision = currentFiles && Array.isArray(currentFiles) && currentFiles.length > 0;
    const health = isRevision ? analyzeProjectHealth(currentFiles) : null;
    const modelId = state.settings.openRouterModel;
    const modelProfile = getModelProfile(modelId);

    devLog('Generation mode:', isRevision ? 'REVISION' : 'NEW PROJECT');
    devLog('Model profile:', modelProfile.family, `(${modelProfile.promptStyle} style)`);
    if (health) {
        devLog('Project health:', health.status, `(${formatTokenCount(health.totalTokens)} tokens)`);
    }

    // Pre-generation validation
    const preValidation = validateGenerationRequest(currentFiles, prompt, modelProfile);
    if (!preValidation.valid) {
        devError('Pre-generation validation failed:', preValidation.reason);
        thinking.log('warning', preValidation.reason);
    }

    // Choose the optimal prompt strategy based on model and project size
    const systemPrompt = isRevision
        ? buildRevisionPrompt(currentFiles, health, modelProfile, prompt)
        : buildNewProjectPrompt(modelProfile, prompt);

    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    // For revisions, include context based on project size and model capabilities
    if (isRevision) {
        const fileContext = buildOptimalContext(currentFiles, health, modelProfile, prompt);
        messages.splice(1, 0, {
            role: "user",
            content: fileContext
        });
    }

    const result = await generateWithOpenRouter(messages);

    // For revisions, merge changes with existing files (now supports edit action)
    if (isRevision && result.files) {
        const mergeResult = mergeFilesEnhanced(currentFiles, result.files);
        result.files = mergeResult.files;

        // Log any merge errors
        if (mergeResult.errors.length > 0) {
            devError('Merge errors:', mergeResult.errors);
            thinking.log('warning', `Some edits failed: ${mergeResult.errors.length} issues`);
        }

        devLog('Merged files:', mergeResult.applied);

        // Post-generation validation with auto-repair for HTML
        const postValidation = validateGenerationResult(currentFiles, result.files, { autoRepair: true });
        if (!postValidation.valid) {
            devError('Post-generation issues:', postValidation.issues);
            for (const issue of postValidation.issues) {
                thinking.log('warning', issue);
            }

            // Attempt recovery for truncation
            if (postValidation.issues.some(i => i.includes('truncation') || i.includes('reduced'))) {
                devLog('Attempting truncation recovery...');
                result.files = attemptTruncationRecovery(currentFiles, result.files);
            }
        }

        // If auto-repair was applied, use the repaired files
        if (postValidation.repaired && postValidation.files) {
            devLog('Applied HTML auto-repair:', postValidation.repairs);
            for (const repair of postValidation.repairs || []) {
                thinking.log('info', `Auto-repaired ${repair.path}: ${repair.repairs.join(', ')}`);
            }
            result.files = postValidation.files;
        }
    }

    // Auto-repair HTML files for new projects (not just revisions)
    if (!isRevision && result.files) {
        const repairResult = validateAndRepairFiles(result.files);
        if (repairResult.repairs.length > 0) {
            devLog('Applied HTML auto-repair to new project:', repairResult.repairs);
            for (const repair of repairResult.repairs) {
                thinking.log('info', `Auto-repaired ${repair.path}: ${repair.repairs.join(', ')}`);
            }
            result.files = repairResult.files;
        }
    }

    // CRITICAL: Ensure index.html exists - this is required for the website to work
    const hasIndexHtml = result.files?.some(f => f.path === 'index.html' || f.path === './index.html');
    if (!hasIndexHtml && result.files) {
        devError('No index.html found - creating fallback');
        thinking.log('warning', 'AI did not create index.html - adding fallback');

        // Create a minimal index.html
        const otherHtmlFiles = result.files.filter(f => f.path.endsWith('.html'));
        const links = otherHtmlFiles.length > 0
            ? otherHtmlFiles.map(f => `<li><a href="${f.path}" class="text-blue-500 hover:underline">${f.path}</a></li>`).join('\n        ')
            : '<li class="text-gray-500">No additional pages</li>';

        const fallbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project</title>
    <script src="https://cdn.twind.style" crossorigin></script>
</head>
<body class="min-h-screen bg-gray-100 p-8">
    <div class="max-w-2xl mx-auto">
        <h1 class="text-3xl font-bold text-gray-800 mb-4">Project Files</h1>
        <p class="text-gray-600 mb-4">The AI created the following files:</p>
        <ul class="list-disc list-inside space-y-2">
        ${links}
        </ul>
        <div class="mt-8 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p class="text-yellow-800 text-sm">Note: The AI didn't create a proper index.html. You may want to regenerate.</p>
        </div>
    </div>
</body>
</html>`;

        result.files.unshift({ path: 'index.html', content: fallbackHtml });
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
 * Build system prompt for new projects with model-specific optimizations
 * Uses the unified prompts.js system with context-aware enhancements
 */
function buildNewProjectPrompt(modelProfile, userPrompt = '') {
    const modelId = modelProfile?.modelId || state.settings.openRouterModel;

    // Get the base system prompt from prompts.js
    let systemPrompt = buildNewProjectSystemPrompt(modelId);

    // Add context-aware technical guidelines based on user prompt
    const technicalNotes = buildTechnicalNotes(userPrompt);
    if (technicalNotes) {
        const style = modelProfile?.promptStyle || 'markdown';
        if (style === 'xml-tags') {
            systemPrompt += `\n\n<context_specific>\n${technicalNotes}\n</context_specific>`;
        } else {
            systemPrompt += `\n\n### Context-Specific Guidelines\n${technicalNotes}`;
        }
    }

    // Add extra emphasis for models with lower JSON reliability
    const jsonReliability = modelProfile?.jsonReliability || 'medium';
    if (jsonReliability === 'low' || jsonReliability === 'medium') {
        systemPrompt += `\n\nREMINDER: You MUST create at least index.html with complete content. For anything beyond basic text, also create styles.css and script.js. Return ONLY valid JSON.`;
    }

    return systemPrompt;
}

/**
 * Build context-aware technical notes based on user prompt
 */
function buildTechnicalNotes(prompt) {
    const notes = [];
    const promptLower = prompt.toLowerCase();

    // 3D/Three.js projects
    if (promptLower.includes('three') || promptLower.includes('3d') || promptLower.includes('webgl')) {
        notes.push('For Three.js/3D:');
        notes.push('- Use WASD for desktop movement, nipple.js (https://esm.sh/nipplejs) for mobile');
        notes.push('- Clamp vertical camera rotation to prevent over-rotation');
        notes.push('- Prioritize smooth frame rates and responsive controls');
    }

    // Game projects
    if (promptLower.includes('game') || promptLower.includes('simulation')) {
        notes.push('For games/simulations:');
        notes.push('- Focus on functionality and user experience over visual flair');
        notes.push('- Use requestAnimationFrame for render/update loops');
        notes.push('- Ensure responsive controls on both desktop and mobile');
    }

    // Audio/Sound
    if (promptLower.includes('sound') || promptLower.includes('audio') || promptLower.includes('music')) {
        notes.push('For audio:');
        notes.push('- Use WebAudio API directly (AudioContext, GainNode, etc.)');
        notes.push('- Do NOT use howler.js or other audio libraries');
    }

    // External libraries
    if (promptLower.includes('library') || promptLower.includes('import') || promptLower.includes('package')) {
        notes.push('For external libraries:');
        notes.push('- Use esm.sh CDN with import maps');
        notes.push('- Example: import { x } from "https://esm.sh/package-name"');
    }

    return notes.length > 0 ? notes.join('\n') : '';
}

/**
 * Build system prompt for revisions - uses efficient edit format with model-specific optimizations
 * Uses the unified prompts.js system
 */
function buildRevisionPrompt(currentFiles, health, modelProfile, userPrompt = '') {
    const modelId = modelProfile?.modelId || state.settings.openRouterModel;
    const style = modelProfile?.promptStyle || 'markdown';
    const useEditFormat = modelProfile?.preferEditFormat !== false;

    // Get the base revision system prompt from prompts.js
    let systemPrompt = buildRevisionSystemPrompt(modelId, useEditFormat);

    // Add file list to the prompt
    const fileList = currentFiles.map(f => {
        const tokens = estimateTokens(f.content);
        const status = tokens >= 5000 ? ' [LARGE]' : '';
        return `- ${f.path} (${formatTokenCount(tokens)} tokens)${status}`;
    }).join('\n');

    const fileListSection = style === 'xml-tags'
        ? `\n<current_files>\n${fileList}\nTotal: ${formatTokenCount(health.totalTokens)} tokens\n</current_files>`
        : `\n\n### Current Project Files\n${fileList}\nTotal: ${formatTokenCount(health.totalTokens)} tokens`;

    systemPrompt += fileListSection;

    // Add context-aware technical guidelines
    const technicalNotes = buildTechnicalNotes(userPrompt);
    if (technicalNotes) {
        if (style === 'xml-tags') {
            systemPrompt += `\n\n<context_specific>\n${technicalNotes}\n</context_specific>`;
        } else {
            systemPrompt += `\n\n### Context-Specific Guidelines\n${technicalNotes}`;
        }
    }

    // Add extra rules
    const rules = style === 'xml-tags'
        ? `\n<rules>
- Only return files that CHANGE - never include unchanged files
- For modify/add: return COMPLETE file content
- Preserve existing functionality unless asked to change
- Files marked [LARGE]: consider splitting when making changes
</rules>`
        : `\n\n### Rules
1. Only return files that CHANGE
2. For modify/add: return COMPLETE content
3. Preserve existing functionality
4. Files marked [LARGE]: consider splitting`;

    systemPrompt += rules;

    return systemPrompt;
}

/**
 * Build optimal context based on project size and model capabilities
 */
function buildOptimalContext(files, health, modelProfile, prompt) {
    const totalTokens = health.totalTokens;

    // Adjust thresholds based on model's context window
    const contextLimit = modelProfile?.contextWindow || 32000;
    const safeLimit = contextLimit * 0.6; // Reserve 40% for output

    // Calculate adaptive thresholds
    const smallThreshold = Math.min(DEFAULT_SMALL_PROJECT_TOKENS, safeLimit * 0.2);
    const mediumThreshold = Math.min(DEFAULT_MEDIUM_PROJECT_TOKENS, safeLimit * 0.5);
    const largeThreshold = Math.min(DEFAULT_LARGE_PROJECT_TOKENS, safeLimit * 0.8);

    devLog('Context thresholds:', { small: smallThreshold, medium: mediumThreshold, large: largeThreshold });
    devLog('Project tokens:', totalTokens, 'Safe limit:', safeLimit);

    // Gemini with 1M context can handle much more
    if (modelProfile?.family === 'gemini' && contextLimit >= 1000000) {
        if (totalTokens < safeLimit * 0.3) {
            devLog('Using FULL context strategy (Gemini large context)');
            return buildFullContext(files);
        }
    }

    // Small projects: include everything
    if (totalTokens < smallThreshold) {
        devLog('Using FULL context strategy');
        return buildFullContext(files);
    }

    // Medium projects: summarized with key excerpts
    if (totalTokens < mediumThreshold) {
        devLog('Using SUMMARIZED context strategy');
        return buildSummarizedContext(files);
    }

    // Large projects: code map with main files
    if (totalTokens < largeThreshold) {
        devLog('Using CODE MAP context strategy');
        return buildCodeMapContext(files);
    }

    // Very large projects: selective context based on prompt
    devLog('Using SELECTIVE context strategy');
    return buildSelectiveContext(files, prompt, safeLimit);
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
 * Selective context - only include files relevant to the prompt
 * For very large projects (50+ files)
 */
function buildSelectiveContext(files, prompt, maxTokens) {
    const promptLower = prompt.toLowerCase();

    // Always include: entry points, config files
    const alwaysInclude = ['index.html', 'index.js', 'main.js', 'app.js', 'config.js', 'package.json'];

    // Score each file for relevance
    const scoredFiles = files.map(f => {
        let score = 0;
        const pathLower = f.path.toLowerCase();
        const contentLower = f.content.toLowerCase();

        // Always include priority files
        if (alwaysInclude.some(p => pathLower.includes(p))) {
            score += 100;
        }

        // Check if file path is mentioned in prompt
        const fileName = f.path.split('/').pop().replace(/\.[^.]+$/, '');
        if (promptLower.includes(fileName.toLowerCase())) {
            score += 50;
        }

        // Check for keyword matches in prompt
        const keywords = prompt.match(/\b\w{4,}\b/g) || [];
        for (const keyword of keywords) {
            if (pathLower.includes(keyword.toLowerCase())) score += 20;
            if (contentLower.includes(keyword.toLowerCase())) score += 5;
        }

        // Boost small files (easier to include)
        const tokens = estimateTokens(f.content);
        if (tokens < 500) score += 10;
        if (tokens < 1000) score += 5;

        return { file: f, score, tokens };
    });

    // Sort by score and select files within token budget
    scoredFiles.sort((a, b) => b.score - a.score);

    const selectedFiles = [];
    let totalTokens = 0;
    const tokenBudget = maxTokens * 0.5; // Use half for files, rest for prompts

    for (const { file, score, tokens } of scoredFiles) {
        if (totalTokens + tokens <= tokenBudget || selectedFiles.length < 3) {
            selectedFiles.push(file);
            totalTokens += tokens;
        }
        if (totalTokens > tokenBudget) break;
    }

    devLog(`Selective context: ${selectedFiles.length} of ${files.length} files (${formatTokenCount(totalTokens)} tokens)`);

    // Build context with selected files
    const fileContents = selectedFiles.map(f =>
        `=== ${f.path} ===\n${f.content}`
    ).join('\n\n');

    // Include file list for awareness
    const fileList = files.map(f => {
        const included = selectedFiles.includes(f) ? ' [INCLUDED]' : '';
        return `- ${f.path}${included}`;
    }).join('\n');

    return `PROJECT FILES (${files.length} total, ${selectedFiles.length} included based on relevance):
${fileList}

INCLUDED FILE CONTENTS:

${fileContents}

Note: This is a LARGE project. I've included the most relevant files.
If you need another file, ask me to provide it.
When modifying files, return COMPLETE content or use edit action for small changes.`;
}

/**
 * Merge AI response files with existing files (legacy - kept for compatibility)
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
 * Enhanced merge with support for edit action and validation
 */
function mergeFilesEnhanced(existingFiles, newFiles) {
    // Use the file-ops mergeWithEdits for full edit support
    const result = mergeWithEdits(existingFiles, newFiles);

    // Log applied changes
    for (const applied of result.applied) {
        devLog(applied);
    }

    return result;
}

/**
 * Validate generation request before sending to AI
 */
function validateGenerationRequest(files, prompt, modelProfile) {
    if (!files || files.length === 0) {
        return { valid: true }; // New project, no validation needed
    }

    const totalTokens = files.reduce((sum, f) => sum + estimateTokens(f.content), 0);
    const contextLimit = modelProfile?.contextWindow || 32000;
    const safeLimit = contextLimit * 0.8;

    if (totalTokens > safeLimit) {
        return {
            valid: false,
            reason: `Project size (${formatTokenCount(totalTokens)}) exceeds safe limit for ${modelProfile?.family || 'this model'} (${formatTokenCount(safeLimit)}). Consider using a model with larger context window.`
        };
    }

    return { valid: true };
}

/**
 * Attempt to recover from truncation by restoring unmodified sections
 */
function attemptTruncationRecovery(originalFiles, newFiles) {
    const recovered = [...newFiles];

    for (let i = 0; i < recovered.length; i++) {
        const newFile = recovered[i];
        const original = originalFiles.find(f => f.path === newFile.path);

        if (!original || !newFile.content) continue;

        const truncCheck = detectTruncation(original.content, newFile.content);

        if (truncCheck.truncated) {
            devLog(`Attempting recovery for truncated file: ${newFile.path}`);

            // Check if the new content is a prefix of the original
            if (original.content.startsWith(newFile.content.trim())) {
                // Complete truncation - restore original
                devLog(`Restored original for ${newFile.path} (complete truncation)`);
                recovered[i] = { ...newFile, content: original.content };
                thinking.log('warning', `Restored ${newFile.path} - AI response was truncated`);
            } else {
                // Partial changes were made - keep new content but warn
                thinking.log('warning', `${newFile.path} may be incomplete - verify changes`);
            }
        }
    }

    return recovered;
}

/**
 * Retry configuration for transient errors
 */
const RETRY_CONFIG = {
    maxRetries: 2,
    retryDelay: 1000, // 1 second
    retryableStatuses: [429, 500, 502, 503, 504], // Rate limits, server errors (NOT 404)
    // 404 with "data policy" message is a user config issue, not transient
    nonRetryableMessages: ['data policy', 'privacy', 'not found']
};

/**
 * Make streaming API call to OpenRouter with retry logic
 */
async function generateWithOpenRouter(messages, retryCount = 0) {
    // Get key from either server session or client-side storage
    const key = getApiKey() || security.getKey();
    if (!key) throw new Error("OpenRouter Key Locked or Missing");

    thinking.show();
    const retryLabel = retryCount > 0 ? ` (retry ${retryCount}/${RETRY_CONFIG.maxRetries})` : '';
    thinking.setStatus('thinking', `Connecting to ${state.settings.openRouterModel}...${retryLabel}`);

    devLog('Starting generation with model:', state.settings.openRouterModel, retryCount > 0 ? `(retry ${retryCount})` : '');
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

            const errorMsg = err.error?.message || response.statusText || `HTTP ${response.status}`;
            const lowerErrorMsg = errorMsg.toLowerCase();

            // Check if error message indicates non-retryable issue
            const isNonRetryable = RETRY_CONFIG.nonRetryableMessages.some(msg => lowerErrorMsg.includes(msg));

            // Check if this is a retryable error
            if (!isNonRetryable && RETRY_CONFIG.retryableStatuses.includes(response.status) && retryCount < RETRY_CONFIG.maxRetries) {
                const errorType = response.status === 429 ? 'Rate limited' : 'Server error';
                thinking.setStatus('thinking', `${errorType}, retrying in ${RETRY_CONFIG.retryDelay/1000}s...`);
                thinking.log('warning', `${errorType} (${response.status}), retry ${retryCount + 1}/${RETRY_CONFIG.maxRetries}`);
                devLog(`Retrying after ${response.status} error...`);

                await new Promise(r => setTimeout(r, RETRY_CONFIG.retryDelay));
                return generateWithOpenRouter(messages, retryCount + 1);
            }

            // Provide helpful message for data policy errors
            if (lowerErrorMsg.includes('data policy') || lowerErrorMsg.includes('privacy')) {
                thinking.setStatus('error', 'Configure OpenRouter privacy settings');
                throw new Error(`OpenRouter requires privacy settings configuration. Visit: https://openrouter.ai/settings/privacy`);
            }

            // Non-retryable or max retries exceeded
            thinking.setStatus('error', `API Error: ${errorMsg}`);
            throw new Error(`OpenRouter Error: ${errorMsg}`);
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

    // Strategy 5.5: Repair truncated JSON strings
    // Handles "Unterminated string in JSON at position X" errors
    try {
        const repaired = repairTruncatedJSON(content);
        if (repaired !== content) {
            const result = JSON.parse(repaired);
            if (validateParsedResult(result)) {
                devLog('Successfully repaired truncated JSON');
                return result;
            }
        }
    } catch (e) {
        devLog('Truncated JSON repair failed:', e.message);
    }

    // Strategy 6: Try to extract individual complete file objects (handles truncated responses)
    try {
        const files = [];
        // Match complete file objects: {"path": "...", "content": "..."}
        const filePattern = /\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"action"\s*:\s*"([^"]+)")?\s*\}/g;
        let match;

        while ((match = filePattern.exec(content)) !== null) {
            const path = match[1];
            // Unescape the content string
            let fileContent = match[2];
            try {
                fileContent = JSON.parse(`"${fileContent}"`);
            } catch (e) {
                // Use as-is if unescaping fails
                fileContent = fileContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
            }

            files.push({
                path: path,
                content: fileContent,
                action: match[3] || 'modify'
            });
        }

        if (files.length > 0) {
            devLog('Extracted', files.length, 'complete file(s) from truncated response');
            return {
                files: files,
                description: 'Generated content (partial response recovered)'
            };
        }
    } catch (e) {
        devLog('File object extraction failed:', e.message);
    }

    // Strategy 7: Try to extract files array directly
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
 * Repair truncated JSON by closing open strings, arrays, and objects
 * Handles common LLM truncation patterns like "Unterminated string"
 * @param {string} content - The possibly truncated JSON content
 * @returns {string} - Repaired JSON string
 */
function repairTruncatedJSON(content) {
    // Find JSON start
    const jsonStart = content.indexOf('{');
    if (jsonStart === -1) return content;

    let json = content.slice(jsonStart);

    // Track state: are we inside a string?
    let inString = false;
    let escapeNext = false;
    let lastValidPos = 0;
    let braceDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < json.length; i++) {
        const char = json[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            if (!inString) {
                // Just closed a string, this is a valid position
                lastValidPos = i;
            }
            continue;
        }

        if (!inString) {
            if (char === '{') {
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
                lastValidPos = i;
            } else if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth--;
                lastValidPos = i;
            } else if (char === ',' || char === ':') {
                lastValidPos = i;
            }
        }
    }

    // If we ended inside a string, the JSON is truncated
    if (inString) {
        devLog('Detected truncated string, attempting repair...');

        // Find the last complete file object before truncation
        // Look for the pattern: }, { or }] which indicates end of a file object
        let repairPoint = lastValidPos;

        // Search backwards from truncation point for a good repair location
        const jsonUpToTruncation = json.slice(0, json.length);

        // Find the last complete "content": "..." pattern
        const lastCompleteContent = jsonUpToTruncation.lastIndexOf('"}');
        if (lastCompleteContent > 0) {
            // Check if there's a complete file object ending here
            const afterContent = jsonUpToTruncation.slice(lastCompleteContent + 2, lastCompleteContent + 10);
            if (afterContent.includes('}') || afterContent.includes(',')) {
                repairPoint = lastCompleteContent + 2;
            }
        }

        // Try to close the JSON structure properly
        let repaired = json.slice(0, repairPoint);

        // Close any open string
        if (inString) {
            repaired += '"';
        }

        // If we're mid-object (after "content": started but not finished)
        // We need to close the string and the object
        if (repaired.endsWith('": "') || repaired.match(/:\s*"[^"]*$/)) {
            // We're mid-value, close it
            repaired += '"';
        }

        // Count remaining open braces and brackets
        let openBraces = 0;
        let openBrackets = 0;
        let inStr = false;
        let esc = false;

        for (const c of repaired) {
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"' && !esc) { inStr = !inStr; continue; }
            if (!inStr) {
                if (c === '{') openBraces++;
                else if (c === '}') openBraces--;
                else if (c === '[') openBrackets++;
                else if (c === ']') openBrackets--;
            }
        }

        // Clean up trailing incomplete syntax
        repaired = repaired.replace(/,\s*$/, ''); // Remove trailing comma
        repaired = repaired.replace(/:\s*$/, ': ""'); // Close incomplete key-value
        repaired = repaired.replace(/"[^"]*$/, '"'); // Close incomplete string

        // Close remaining brackets and braces
        for (let i = 0; i < openBrackets; i++) {
            repaired += ']';
        }
        for (let i = 0; i < openBraces; i++) {
            repaired += '}';
        }

        // Try to parse and validate
        try {
            const test = JSON.parse(repaired);
            if (test && test.files && Array.isArray(test.files) && test.files.length > 0) {
                devLog('Repaired JSON has', test.files.length, 'file(s)');
                return repaired;
            }
        } catch (e) {
            devLog('Repair attempt did not produce valid JSON:', e.message);
        }

        // Fallback: try to extract just complete file objects
        return extractCompleteFilesAsJSON(json);
    }

    // Not truncated mid-string, just close any unbalanced structures
    if (braceDepth > 0 || bracketDepth > 0) {
        let repaired = json;
        for (let i = 0; i < bracketDepth; i++) {
            repaired += ']';
        }
        for (let i = 0; i < braceDepth; i++) {
            repaired += '}';
        }
        return repaired;
    }

    return content;
}

/**
 * Extract complete file objects from partially valid JSON
 * @param {string} json - JSON string that may be truncated
 * @returns {string} - Valid JSON with extracted files
 */
function extractCompleteFilesAsJSON(json) {
    const files = [];

    // Match complete file objects with path and content
    // This regex handles escaped characters in content
    const fileRegex = /\{\s*"path"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"action"\s*:\s*"([^"]+)")?\s*\}/g;

    let match;
    while ((match = fileRegex.exec(json)) !== null) {
        try {
            const path = JSON.parse(`"${match[1]}"`);
            const content = JSON.parse(`"${match[2]}"`);
            const action = match[3] || 'modify';

            files.push({ path, content, action });
        } catch (e) {
            // Skip malformed file objects
            devLog('Skipping malformed file object');
        }
    }

    if (files.length > 0) {
        devLog('Extracted', files.length, 'complete file(s) from truncated response');
        return JSON.stringify({
            files: files,
            description: 'Recovered from truncated response'
        });
    }

    return json; // Return original if no files found
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
    // Get key from either server session or client-side storage
    const key = getApiKey() || security.getKey();
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

        // Simple rule: if limit is 0, user can only use free models
        // They have no credits to spend on paid models
        const isFreeTier = limit === 0;

        devLog('Credit detection:', { limit, usage, isFreeTier });

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
    // Get key from either server session or client-side storage
    const key = getApiKey() || security.getKey();
    if (!key) {
        devLog('fetchModelsWithCredits: No API key available');
        return [];
    }
    devLog('fetchModelsWithCredits: Got API key, fetching models...');

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

        const sortedModels = models.sort((a, b) => a.name.localeCompare(b.name));

        // Return both models and credits info to avoid duplicate API calls
        return { models: sortedModels, credits: creditsInfo };
    } catch (e) {
        devError('Failed to fetch models:', e);
        return { models: [], credits: null };
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

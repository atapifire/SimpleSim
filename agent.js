/**
 * Agent Mode Runtime
 * Multi-pass agentic generation with tool calling
 * Enhanced with model-specific prompts and surgical edit tools
 */

import { state } from './state.js';
import { security } from './security.js';
import { thinking, devLog, devError } from './thinking.js';
import { analyzeProjectHealth, generateCodeMap, estimateTokens, formatTokenCount } from './tokens.js';
import { checkModelToolSupport } from './ai.js';
import { getApiKey } from './job-queue.js';
import { getModelProfile, getPromptStyle } from './model-profiles.js';
import { applyEdits, validateEdits, validateFileSyntax, validateAndRepairFiles } from './file-ops.js';
import { TECHNICAL_GUIDELINES, getLibraryInstructions } from './protocol-data.js';

// Agent configuration
const MAX_ITERATIONS = 10;
const API_TIMEOUT = 180000;

// Starter template for new projects - ensures all models have a foundation
const STARTER_TEMPLATE = {
    path: 'index.html',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Project</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gray-100">
    <div class="container mx-auto px-4 py-8">
        <h1 class="text-3xl font-bold text-gray-800 mb-4">Welcome</h1>
        <p class="text-gray-600">Edit this template to build your website.</p>
    </div>
</body>
</html>`
};

// Working files state during agent execution
let workingFiles = [];
let iterationCount = 0;

/**
 * Available tools for the agent
 * Enhanced with edit_file, read_file_section, and validate_file
 */
const TOOLS = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the full content of a file in the project",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "The file path to read (e.g., 'index.html', 'styles.css')"
                    }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_file_section",
            description: "Read a specific section of a file by line numbers. Use for large files to avoid reading everything.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "The file path to read"
                    },
                    start_line: {
                        type: "number",
                        description: "Starting line number (1-indexed)"
                    },
                    end_line: {
                        type: "number",
                        description: "Ending line number (inclusive)"
                    }
                },
                required: ["path", "start_line", "end_line"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Create or overwrite a file with new content. Use for new files or complete rewrites.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "The file path to write (e.g., 'index.html', 'components/header.js')"
                    },
                    content: {
                        type: "string",
                        description: "The complete file content to write"
                    }
                },
                required: ["path", "content"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Make surgical edits to a file using search/replace. More efficient than rewriting entire file. Use for small to medium changes.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "The file path to edit"
                    },
                    edits: {
                        type: "array",
                        description: "Array of search/replace operations",
                        items: {
                            type: "object",
                            properties: {
                                search: {
                                    type: "string",
                                    description: "Exact text to find (must be unique in file)"
                                },
                                replace: {
                                    type: "string",
                                    description: "Text to replace it with"
                                }
                            },
                            required: ["search", "replace"]
                        }
                    }
                },
                required: ["path", "edits"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "delete_file",
            description: "Delete a file from the project",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "The file path to delete"
                    }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_files",
            description: "List all files in the project with their sizes and line counts",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_files",
            description: "Search for text across all project files",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Text or regex pattern to search for"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "validate_file",
            description: "Check if a file is valid (parseable HTML/JS/CSS). Call after edits to verify changes.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "The file path to validate"
                    }
                },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "finish",
            description: "Signal that all changes are complete and ready to commit",
            parameters: {
                type: "object",
                properties: {
                    summary: {
                        type: "string",
                        description: "Brief summary of all changes made"
                    }
                },
                required: ["summary"]
            }
        }
    }
];

/**
 * Execute a tool call
 * Enhanced with edit_file, read_file_section, and validate_file
 */
function executeTool(name, args) {
    devLog(`Executing tool: ${name}`, args);

    switch (name) {
        case 'read_file': {
            const file = workingFiles.find(f => f.path === args.path);
            if (file) {
                const lines = file.content.split('\n').length;
                return {
                    success: true,
                    content: file.content,
                    lines: lines,
                    hint: lines > 200 ? 'Large file. Consider using read_file_section for specific parts.' : undefined
                };
            }
            return { success: false, error: `File not found: ${args.path}` };
        }

        case 'read_file_section': {
            const file = workingFiles.find(f => f.path === args.path);
            if (!file) {
                return { success: false, error: `File not found: ${args.path}` };
            }

            const lines = file.content.split('\n');
            const startLine = Math.max(1, args.start_line || 1);
            const endLine = Math.min(lines.length, args.end_line || lines.length);

            if (startLine > lines.length) {
                return { success: false, error: `Start line ${startLine} exceeds file length (${lines.length} lines)` };
            }

            const section = lines.slice(startLine - 1, endLine);
            return {
                success: true,
                content: section.join('\n'),
                start_line: startLine,
                end_line: endLine,
                total_lines: lines.length
            };
        }

        case 'write_file': {
            const existingIndex = workingFiles.findIndex(f => f.path === args.path);
            if (existingIndex !== -1) {
                workingFiles[existingIndex].content = args.content;
                devLog(`Updated file: ${args.path}`);
            } else {
                workingFiles.push({ path: args.path, content: args.content });
                devLog(`Created file: ${args.path}`);
            }
            return { success: true, message: `File written: ${args.path}` };
        }

        case 'edit_file': {
            const file = workingFiles.find(f => f.path === args.path);
            if (!file) {
                return { success: false, error: `File not found: ${args.path}` };
            }

            if (!args.edits || !Array.isArray(args.edits) || args.edits.length === 0) {
                return { success: false, error: 'No edits provided. Expected array of {search, replace} objects.' };
            }

            // Validate edits first
            const validation = validateEdits(file.content, args.edits);
            if (!validation.valid) {
                return {
                    success: false,
                    error: 'Edit validation failed',
                    issues: validation.errors,
                    hint: 'Make sure search strings are unique and match exactly. Include more context if needed.'
                };
            }

            // Apply edits
            const result = applyEdits(file.content, args.edits);
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    failedEdit: result.failedEdit,
                    suggestion: result.suggestion
                };
            }

            // Update file content
            file.content = result.content;
            devLog(`Edited file: ${args.path} (${args.edits.length} changes)`);

            return {
                success: true,
                message: `Applied ${args.edits.length} edit(s) to ${args.path}`,
                hint: 'Call validate_file to verify changes are valid.'
            };
        }

        case 'delete_file': {
            const index = workingFiles.findIndex(f => f.path === args.path);
            if (index !== -1) {
                workingFiles.splice(index, 1);
                devLog(`Deleted file: ${args.path}`);
                return { success: true, message: `File deleted: ${args.path}` };
            }
            return { success: false, error: `File not found: ${args.path}` };
        }

        case 'list_files': {
            const fileList = workingFiles.map(f => ({
                path: f.path,
                size: f.content.length,
                tokens: estimateTokens(f.content),
                lines: f.content.split('\n').length
            }));
            return { success: true, files: fileList };
        }

        case 'search_files': {
            const results = [];
            let regex;
            try {
                regex = new RegExp(args.query, 'gi');
            } catch (e) {
                // Fall back to literal search if regex is invalid
                regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            }

            for (const file of workingFiles) {
                const matches = [];
                const lines = file.content.split('\n');

                lines.forEach((line, i) => {
                    regex.lastIndex = 0; // Reset regex state
                    if (regex.test(line)) {
                        matches.push({ line: i + 1, content: line.trim().substring(0, 100) });
                    }
                });

                if (matches.length > 0) {
                    results.push({ path: file.path, matches: matches.slice(0, 5) });
                }
            }

            return { success: true, results };
        }

        case 'validate_file': {
            const file = workingFiles.find(f => f.path === args.path);
            if (!file) {
                return { success: false, error: `File not found: ${args.path}` };
            }

            const validation = validateFileSyntax(args.path, file.content);
            return {
                success: true,
                valid: validation.valid,
                error: validation.error,
                warnings: validation.warnings
            };
        }

        case 'finish': {
            return { success: true, finished: true, summary: args.summary };
        }

        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
}

/**
 * Build the agent system prompt with model-specific optimizations
 */
function buildAgentSystemPrompt(isNewProject, modelProfile, userPrompt = '') {
    const mode = isNewProject ? 'CREATE' : 'MODIFY';
    const style = modelProfile?.promptStyle || 'markdown';

    // Critical rules for all models (especially important for weaker models)
    const criticalRules = `
CRITICAL RULES - YOU MUST FOLLOW THESE:
1. This is a STATIC WEBSITE builder. You create web projects.
2. index.html MUST exist - it is the main entry point. NEVER delete it.
3. You may create any file types needed (.html, .css, .js, .json, .txt, .md, etc.)
4. The main content should be in index.html - users see this first.
5. No server-side code (no PHP, Python, etc.) - static files only.
6. Don't ask questions - the user cannot see your questions.`;

    // Base tool documentation
    const toolDocs = `
- read_file(path): Read a file's content
- read_file_section(path, start_line, end_line): Read specific lines (for large files)
- write_file(path, content): Create or overwrite a file
- edit_file(path, edits): Make surgical changes using search/replace
- delete_file(path): Remove a file
- list_files(): See all project files with sizes
- search_files(query): Find text across files
- validate_file(path): Check if file syntax is valid
- finish(summary): Complete the task`;

    // Efficiency rules
    const efficiencyRules = `
EFFICIENCY RULES:
1. Use read_file_section for large files (>200 lines) - read only what you need
2. Use edit_file for small changes - avoids full file rewrites
3. Use write_file only for new files or complete rewrites
4. Call validate_file after making changes to verify syntax
5. Call list_files first to understand project structure

CHANGE STRATEGY:
- Small change (<10 lines): Use edit_file with search/replace
- Medium change (10-50 lines): Use edit_file with multiple edits
- Large change (>50 lines or structural): Use write_file`;

    // Requirements (same for all)
    const requirements = `
REQUIREMENTS:
- index.html MUST be the main page (REQUIRED - never delete)
- Use Tailwind CSS: <script src="https://cdn.tailwindcss.com"></script>
- Write clean, semantic HTML5
- Use vanilla JavaScript (no frameworks)
- Images: https://picsum.photos/WIDTH/HEIGHT or placeholder divs (NO base64 data URLs)
- Make it mobile-responsive
- Keep individual files under 200 lines when practical`;

    // Get context-aware technical guidelines
    const technicalNotes = buildAgentTechnicalNotes(userPrompt);

    // Model-specific formatting
    if (style === 'xml-tags') {
        // Claude-optimized prompt
        return `<role>You are an expert Frontend Developer agent building STATIC WEBSITES.</role>

<critical>${criticalRules}</critical>

<mode>${mode}</mode>

<tools>${toolDocs}
</tools>

<workflow>
1. ${isNewProject ? 'Read index.html to see the starter template, then build on it' : 'Use list_files() to understand the project, then read_file() for specific files'}
2. Use edit_file to modify index.html with the requested content
3. Add styles.css and script.js if needed
4. Validate changes with validate_file
5. Call finish() with a summary when done
</workflow>
${efficiencyRules}
${requirements}
${technicalNotes ? `\n<technical_notes>${technicalNotes}</technical_notes>` : ''}
<important>
- Make changes incrementally
- index.html MUST remain as the main entry point
- Preserve existing functionality unless asked to change
- Call finish() ONLY when ALL changes are complete
</important>`;
    }

    // Default markdown-style prompt (GPT, Gemini, Llama, etc.)
    return `You are an expert Frontend Developer agent building STATIC WEBSITES.

${criticalRules}

### Mode: ${mode}

### Available Tools
${toolDocs}

### Workflow
1. ${isNewProject ? 'Read index.html to see the starter template, then build on it' : 'Use list_files() to understand the project, then read_file() for specific files'}
2. Use edit_file to modify index.html with the requested content
3. Add styles.css and script.js if needed
4. Validate changes with validate_file
5. Call finish() with a summary when done
${efficiencyRules}
${requirements}
${technicalNotes ? `\n### Technical Notes\n${technicalNotes}` : ''}
### Important
- Make changes incrementally
- index.html MUST remain as the main entry point
- Preserve existing functionality unless asked to change
- Call finish() ONLY when ALL changes are complete`;
}

/**
 * Build context-aware technical notes for agent mode
 */
function buildAgentTechnicalNotes(prompt) {
    const notes = [];
    const promptLower = prompt.toLowerCase();

    // 3D/Three.js projects
    if (promptLower.includes('three') || promptLower.includes('3d') || promptLower.includes('webgl')) {
        notes.push('For Three.js/3D:');
        notes.push('- Use WASD for desktop movement');
        notes.push('- Use nipple.js (https://esm.sh/nipplejs) for mobile controls');
        notes.push('- Clamp vertical camera rotation between -PI/2 and PI/2');
        notes.push('- Prioritize smooth frame rates over visual complexity');
    }

    // Game projects
    if (promptLower.includes('game') || promptLower.includes('simulation')) {
        notes.push('For games/simulations:');
        notes.push('- Focus on functionality and responsive controls');
        notes.push('- Use requestAnimationFrame for render loops');
        notes.push('- Test both desktop and mobile input');
    }

    // Audio/Sound
    if (promptLower.includes('sound') || promptLower.includes('audio') || promptLower.includes('music')) {
        notes.push('For audio:');
        notes.push('- Use WebAudio API directly (AudioContext, GainNode)');
        notes.push('- Do NOT use howler.js or other audio libraries');
    }

    // External libraries
    if (promptLower.includes('library') || promptLower.includes('import') || promptLower.includes('package')) {
        notes.push('For external libraries:');
        notes.push('- Use esm.sh CDN: import { x } from "https://esm.sh/package"');
        notes.push('- Add import maps in the HTML head section');
    }

    return notes.length > 0 ? notes.join('\n') : '';
}

/**
 * Run the agent loop
 */
export async function runAgent(prompt, currentFiles) {
    const isNewProject = !currentFiles || currentFiles.length === 0;

    // Check if model supports tool calling
    const modelId = state.settings.openRouterModel;
    const toolSupport = getToolSupportLevel(modelId);

    if (toolSupport === 'none') {
        // Check if it's a free model - these often claim tool support but don't work
        const isFreeModel = modelId.includes(':free');
        const shortName = modelId.split('/').pop();

        let errorMsg;
        if (isFreeModel) {
            errorMsg = `Agent Mode doesn't work reliably with free models.\n\n"${shortName}" is a free tier model that may not support tool calling.\n\nSwitch to Simple Mode (works great with all models), or upgrade to a paid model like Claude 3.5 Sonnet.`;
        } else {
            errorMsg = `Agent Mode requires a model with tool support.\n\n"${shortName}" doesn't support tools.\n\nSwitch to Simple Mode, or select a model like Claude, GPT-4, or Gemini Pro.`;
        }

        thinking.show();
        thinking.setStatus('error', 'Model does not support Agent Mode');
        thinking.log('error', `${shortName} doesn't support tool calling`);
        setTimeout(() => thinking.hide(), 3000);
        throw new Error(errorMsg);
    }

    // Initialize working state
    // For new projects, start with a minimal HTML template so all models have a foundation
    workingFiles = isNewProject ? [{ ...STARTER_TEMPLATE }] : JSON.parse(JSON.stringify(currentFiles));
    iterationCount = 0;

    // Get key from either server session or client-side storage
    const key = getApiKey() || security.getKey();
    if (!key) throw new Error("OpenRouter Key Locked or Missing");

    thinking.show();

    // Warn about partial support
    if (toolSupport === 'partial') {
        thinking.setStatus('thinking', 'Agent starting (limited tool support)...');
        thinking.log('warning', `${modelId} has limited tool support - results may vary`);
    } else {
        thinking.setStatus('thinking', 'Agent starting...');
    }

    // Get model profile for optimized prompts
    const modelProfile = getModelProfile(modelId);

    devLog('Agent mode:', isNewProject ? 'NEW PROJECT' : 'MODIFY EXISTING');
    devLog('Model tool support:', toolSupport, modelId);
    devLog('Model profile:', modelProfile.family, `(${modelProfile.promptStyle} style)`);

    // Build initial messages with model-specific prompts
    const messages = [
        { role: "system", content: buildAgentSystemPrompt(isNewProject, modelProfile, prompt) }
    ];

    // For new projects, tell the agent about the starter template
    if (isNewProject) {
        messages.push({
            role: "user",
            content: `STARTER TEMPLATE PROVIDED:\n- index.html (basic HTML5 + Tailwind CSS template)\n\nYou can read and modify this file. Build upon it to create the requested website.`
        });
        messages.push({
            role: "assistant",
            content: "I see the starter template. I'll build upon index.html to create the requested website, adding styles and JavaScript as needed."
        });
    } else {
        // For existing projects, provide context
        const health = analyzeProjectHealth(currentFiles);
        const fileList = currentFiles.map(f => `- ${f.path} (${estimateTokens(f.content)} tokens)`).join('\n');

        messages.push({
            role: "user",
            content: `CURRENT PROJECT FILES:\n${fileList}\n\nTotal: ${formatTokenCount(health.totalTokens)} tokens`
        });

        messages.push({
            role: "assistant",
            content: "I understand the project structure. I'll use read_file() to examine specific files as needed."
        });
    }

    // Add user request
    messages.push({
        role: "user",
        content: prompt
    });

    let finished = false;
    let finalSummary = '';

    // Agent loop
    while (!finished && iterationCount < MAX_ITERATIONS) {
        iterationCount++;
        thinking.setStatus('thinking', `Agent iteration ${iterationCount}/${MAX_ITERATIONS}...`);
        thinking.log('iteration', `Starting iteration ${iterationCount}`);
        devLog(`--- Agent iteration ${iterationCount} ---`);

        try {
            const response = await callOpenRouterWithTools(messages, key);

            // Check for tool calls
            const toolCalls = response.tool_calls;

            if (toolCalls && toolCalls.length > 0) {
                // Add assistant message with tool calls
                messages.push({
                    role: "assistant",
                    content: response.content || null,
                    tool_calls: toolCalls
                });

                // Execute each tool call
                for (const toolCall of toolCalls) {
                    const toolName = toolCall.function.name;
                    let toolArgs = {};

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments);
                    } catch (e) {
                        devError('Failed to parse tool arguments:', toolCall.function.arguments);
                    }

                    thinking.log('tool', `${toolName}(${JSON.stringify(toolArgs).substring(0, 50)}...)`);

                    const result = executeTool(toolName, toolArgs);

                    // Add tool result to messages
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result)
                    });

                    // Check if agent is done
                    if (result.finished) {
                        finished = true;
                        finalSummary = result.summary;
                        devLog('Agent finished:', finalSummary);
                    }
                }
            } else if (response.content) {
                // No tool calls, just text response
                messages.push({
                    role: "assistant",
                    content: response.content
                });

                // Check if this is the first iteration with no progress - model may not support tools
                if (iterationCount === 1 && workingFiles.length === 0 && isNewProject) {
                    devLog('First iteration: model responded with text but no tool calls');
                    thinking.log('warning', 'Model not using tools - may not support Agent Mode');

                    // Give the model one more chance with explicit tool instruction
                    messages.push({
                        role: "user",
                        content: "You MUST use the tools to complete this task. Start by calling write_file() to create index.html. Do not respond with code in text - use the write_file tool."
                    });
                    continue;
                }

                // Check if the model thinks it's done without calling finish
                if (response.content.toLowerCase().includes('complete') ||
                    response.content.toLowerCase().includes('finished') ||
                    response.content.toLowerCase().includes('all changes')) {

                    // Prompt for finish call
                    messages.push({
                        role: "user",
                        content: "Please call the finish() tool with a summary to complete the task."
                    });
                }
            } else {
                // Empty response
                devError('Empty response from agent');

                // If first iteration with no files, this model likely doesn't work with Agent Mode
                if (iterationCount === 1 && workingFiles.length === 0) {
                    thinking.setStatus('error', 'Model returned empty response');
                    throw new Error(
                        `Model "${state.settings.openRouterModel}" returned an empty response in Agent Mode.\n\n` +
                        `This model may not support tool/function calling.\n\n` +
                        `Try:\n` +
                        `• Switch to Simple Mode (works with all models)\n` +
                        `• Use a model with tool support (Claude, GPT-4, Gemini Pro)`
                    );
                }

                // Later iterations - might be a transient issue, break and use what we have
                break;
            }

        } catch (error) {
            devError('Agent iteration failed:', error);
            thinking.setStatus('error', `Iteration ${iterationCount} failed: ${error.message}`);
            throw error;
        }
    }

    if (!finished && iterationCount >= MAX_ITERATIONS) {
        thinking.log('warning', 'Max iterations reached, using current state');
        finalSummary = 'Agent reached maximum iterations - changes may be incomplete';
    }

    // Validate we have files to return
    if (!workingFiles || workingFiles.length === 0) {
        thinking.setStatus('error', 'Agent produced no files');
        devError('Agent completed with no files after', iterationCount, 'iterations');

        // Provide helpful error based on context
        const modelName = state.settings.openRouterModel.split('/').pop();
        const isFreeModel = state.settings.openRouterModel.includes(':free');

        let errorMsg = `Agent completed but produced no files.\n\n`;

        if (isFreeModel) {
            errorMsg += `Free models often don't support tool calling properly.\n\n`;
        } else {
            errorMsg += `The model "${modelName}" may not support Agent Mode well.\n\n`;
        }

        errorMsg += `Solutions:\n`;
        errorMsg += `• Switch to Simple Mode (fast, works with all models)\n`;
        errorMsg += `• Try a model with full tool support:\n`;
        errorMsg += `  - Claude 3.5 Sonnet\n`;
        errorMsg += `  - GPT-4 / GPT-4o\n`;
        errorMsg += `  - Gemini Pro`;

        throw new Error(errorMsg);
    }

    // Ensure all files have valid content
    workingFiles = workingFiles.filter(f => {
        if (!f.path) {
            devLog('Filtering out file without path');
            return false;
        }
        if (typeof f.content !== 'string') {
            devLog('Filtering out file without content:', f.path);
            return false;
        }
        return true;
    });

    if (workingFiles.length === 0) {
        thinking.setStatus('error', 'No valid files after filtering');
        throw new Error('Agent produced no valid files');
    }

    // Auto-repair HTML files (handles truncation and missing tags from LLMs)
    const repairResult = validateAndRepairFiles(workingFiles);
    if (repairResult.repairs.length > 0) {
        devLog('Auto-repaired HTML files:', repairResult.repairs);
        for (const repair of repairResult.repairs) {
            thinking.log('info', `Auto-repaired ${repair.path}: ${repair.repairs.join(', ')}`);
        }
        workingFiles = repairResult.files;
    }

    // CRITICAL: Ensure index.html exists - this is required for the website to work
    const hasIndexHtml = workingFiles.some(f => f.path === 'index.html' || f.path === './index.html');
    if (!hasIndexHtml) {
        devError('No index.html found - creating fallback');
        thinking.log('warning', 'AI did not create index.html - adding fallback');

        // Create a minimal index.html
        const otherHtmlFiles = workingFiles.filter(f => f.path.endsWith('.html'));
        const links = otherHtmlFiles.length > 0
            ? otherHtmlFiles.map(f => `<li><a href="${f.path}" class="text-blue-500 hover:underline">${f.path}</a></li>`).join('\n        ')
            : '<li class="text-gray-500">No additional pages</li>';

        const fallbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project</title>
    <script src="https://cdn.tailwindcss.com"></script>
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

        workingFiles.unshift({ path: 'index.html', content: fallbackHtml });
    }

    thinking.setStatus('complete', `Agent completed in ${iterationCount} iterations`);
    devLog('Agent complete. Final files:', workingFiles.map(f => f.path));

    setTimeout(() => thinking.hide(), 2000);

    return {
        files: workingFiles,
        description: finalSummary || `Agent made changes in ${iterationCount} iterations`,
        iterations: iterationCount
    };
}

/**
 * Retry configuration for transient errors
 */
const RETRY_CONFIG = {
    maxRetries: 2,
    retryDelay: 1000,
    retryableStatuses: [429, 500, 502, 503, 504], // NOT 404 - often means model/config issue
    nonRetryableMessages: ['data policy', 'privacy', 'not found', 'does not exist']
};

/**
 * Call OpenRouter API with tool support and retry logic
 */
async function callOpenRouterWithTools(messages, key, retryCount = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        devError('Agent API call timed out after', API_TIMEOUT / 1000, 'seconds');
    }, API_TIMEOUT);

    try {
        const retryLabel = retryCount > 0 ? ` (retry ${retryCount})` : '';
        thinking.log('tool', `Calling ${state.settings.openRouterModel}...${retryLabel}`);

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": window.location.origin,
                "X-Title": "SimpleSim Agent"
            },
            body: JSON.stringify({
                model: state.settings.openRouterModel,
                messages: messages,
                tools: TOOLS,
                tool_choice: "auto"
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const errorMsg = err.error?.message || response.statusText || `HTTP ${response.status}`;
            const lowerErrorMsg = errorMsg.toLowerCase();
            devError('Agent API error:', response.status, errorMsg);

            // Check if error message indicates non-retryable issue
            const isNonRetryable = RETRY_CONFIG.nonRetryableMessages.some(msg => lowerErrorMsg.includes(msg));

            // Check if retryable
            if (!isNonRetryable && RETRY_CONFIG.retryableStatuses.includes(response.status) && retryCount < RETRY_CONFIG.maxRetries) {
                const errorType = response.status === 429 ? 'Rate limited' : 'Server error';
                thinking.log('warning', `${errorType}, retrying...`);
                devLog(`Retrying agent call after ${response.status} error...`);

                await new Promise(r => setTimeout(r, RETRY_CONFIG.retryDelay));
                return callOpenRouterWithTools(messages, key, retryCount + 1);
            }

            // Provide helpful message for data policy errors
            if (lowerErrorMsg.includes('data policy') || lowerErrorMsg.includes('privacy')) {
                throw new Error(`OpenRouter requires privacy settings. Visit: https://openrouter.ai/settings/privacy`);
            }

            throw new Error(`API Error: ${errorMsg}`);
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            devError('Invalid API response structure:', data);
            throw new Error('Invalid response from AI model');
        }

        return data.choices[0].message;

    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            throw new Error('Agent request timed out - try a simpler prompt');
        }

        throw error;
    }
}

/**
 * Check if the current model supports tool calling
 * Uses centralized check from ai.js
 */
export function supportsToolCalling(modelId) {
    const support = checkModelToolSupport(modelId);
    return support === 'full' || support === 'partial';
}

/**
 * Get detailed tool support level
 */
export function getToolSupportLevel(modelId) {
    return checkModelToolSupport(modelId);
}

/**
 * Get agent mode status
 */
export function isAgentModeEnabled() {
    return state.settings.agentMode === true;
}

/**
 * Toggle agent mode
 */
export function setAgentMode(enabled) {
    state.settings.agentMode = enabled;
    localStorage.setItem('app_settings', JSON.stringify({
        ...JSON.parse(localStorage.getItem('app_settings') || '{}'),
        agentMode: enabled
    }));
    devLog('Agent mode:', enabled ? 'ENABLED' : 'DISABLED');
}

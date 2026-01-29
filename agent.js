/**
 * Agent Mode Runtime
 * Multi-pass agentic generation with tool calling
 */

import { state } from './state.js';
import { security } from './security.js';
import { thinking, devLog, devError } from './thinking.js';
import { analyzeProjectHealth, generateCodeMap, estimateTokens, formatTokenCount } from './tokens.js';
import { checkModelToolSupport } from './ai.js';

// Agent configuration
const MAX_ITERATIONS = 10;
const API_TIMEOUT = 180000;

// Working files state during agent execution
let workingFiles = [];
let iterationCount = 0;

/**
 * Available tools for the agent
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
            name: "write_file",
            description: "Create or overwrite a file with new content",
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
            description: "List all files in the project with their sizes",
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
 */
function executeTool(name, args) {
    devLog(`Executing tool: ${name}`, args);

    switch (name) {
        case 'read_file': {
            const file = workingFiles.find(f => f.path === args.path);
            if (file) {
                return { success: true, content: file.content };
            }
            return { success: false, error: `File not found: ${args.path}` };
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
            const regex = new RegExp(args.query, 'gi');

            for (const file of workingFiles) {
                const matches = [];
                const lines = file.content.split('\n');

                lines.forEach((line, i) => {
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

        case 'finish': {
            return { success: true, finished: true, summary: args.summary };
        }

        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
}

/**
 * Build the agent system prompt
 */
function buildAgentSystemPrompt(isNewProject) {
    const mode = isNewProject ? 'CREATE' : 'MODIFY';

    return `You are an expert Frontend Developer agent. You ${isNewProject ? 'create' : 'modify'} static websites through iterative tool calls.

MODE: ${mode}

AVAILABLE TOOLS:
- read_file(path): Read a file's content
- write_file(path, content): Create or update a file
- delete_file(path): Remove a file
- list_files(): See all project files with sizes
- search_files(query): Find text across files
- finish(summary): Complete the task and commit changes

WORKFLOW:
1. ${isNewProject ? 'Plan the file structure' : 'Use list_files() and read_file() to understand the current project'}
2. Make changes using write_file() - one file at a time
3. Continue until all requested changes are complete
4. Call finish() with a summary when done

REQUIREMENTS:
- Always include index.html as entry point
- Use Tailwind CSS: <script src="https://cdn.tailwindcss.com"></script>
- Write clean, semantic HTML5
- Use vanilla JavaScript
- Images: https://picsum.photos/WIDTH/HEIGHT or placeholder divs
- Make it mobile-responsive
- Keep individual files under 200 lines when practical

IMPORTANT:
- Make changes incrementally - don't try to do everything in one call
- Test your understanding by reading files before modifying
- When modifying existing code, preserve existing functionality unless asked to change
- Call finish() ONLY when ALL changes are complete`;
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
        const errorMsg = `Agent Mode requires a model with tool support.\n\n"${modelId}" doesn't support tools.\n\nSwitch to Simple Mode, or select a model like Claude, GPT-4, or Gemini Pro.`;
        thinking.show();
        thinking.setStatus('error', 'Model does not support Agent Mode');
        thinking.log('error', `${modelId} doesn't support tool calling`);
        setTimeout(() => thinking.hide(), 3000);
        throw new Error(errorMsg);
    }

    // Initialize working state
    workingFiles = isNewProject ? [] : JSON.parse(JSON.stringify(currentFiles));
    iterationCount = 0;

    const key = security.getKey();
    if (!key) throw new Error("OpenRouter Key Locked or Missing");

    thinking.show();

    // Warn about partial support
    if (toolSupport === 'partial') {
        thinking.setStatus('thinking', 'Agent starting (limited tool support)...');
        thinking.log('warning', `${modelId} has limited tool support - results may vary`);
    } else {
        thinking.setStatus('thinking', 'Agent starting...');
    }

    devLog('Agent mode:', isNewProject ? 'NEW PROJECT' : 'MODIFY EXISTING');
    devLog('Model tool support:', toolSupport, modelId);

    // Build initial messages
    const messages = [
        { role: "system", content: buildAgentSystemPrompt(isNewProject) }
    ];

    // For existing projects, provide context
    if (!isNewProject) {
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
                // Empty response, break
                devError('Empty response from agent');
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
        devError('Agent completed with no files');
        throw new Error('Agent completed but produced no files - try again');
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
 * Call OpenRouter API with tool support
 */
async function callOpenRouterWithTools(messages, key) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        devError('Agent API call timed out after', API_TIMEOUT / 1000, 'seconds');
    }, API_TIMEOUT);

    try {
        thinking.log('tool', `Calling ${state.settings.openRouterModel}...`);

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
            const errorMsg = err.error?.message || response.statusText;
            devError('Agent API error:', response.status, errorMsg);
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

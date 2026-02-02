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
import { applyEdits, validateEdits, validateFileSyntax, validateAndRepairFiles, analyzeDomReferences } from './file-ops.js';
import { getPreviewErrors, clearPreviewErrors, renderProject } from './renderer.js';
import { TECHNICAL_GUIDELINES, getLibraryInstructions } from './protocol-data.js';
import { formatLibraryDocs, detectLibraries, analyzeLibraryError, searchLibraries, getCategories } from './library-catalog.js';
import {
    buildAgentSystemPrompt as buildAgentSystemPromptBase,
    buildAgentUserMessage,
    TECHNOLOGY_STACK,
    IMAGE_HANDLING,
    INTERACTIVE_FEATURES
} from './prompts.js';

// Agent configuration
const MAX_ITERATIONS = 10;
const API_TIMEOUT = 180000;

// Starter template for new projects - minimal foundation
// No styling frameworks are forced - models choose what they need
const STARTER_FILES = [
    {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Project</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <script src="script.js"></script>
</body>
</html>`
    },
    {
        path: 'style.css',
        content: `/* Add your styles here */`
    },
    {
        path: 'script.js',
        content: `// Add your JavaScript here`
    }
];

// Working files state during agent execution
let workingFiles = [];
let iterationCount = 0;

// Validation tracking - ensures agent checks for errors before finishing
let validationState = {
    errorCheckPerformed: false,   // True if check_dom or get_preview_errors was called
    previewRendered: false,       // True if preview_site was called
    lastDomCheckResult: null,     // Result of last check_dom call
    lastPreviewErrors: null,      // Result of last get_preview_errors call
    filesModifiedSinceCheck: false // True if files changed after last error check
};

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
            name: "preview_site",
            description: "Render the current project files in the preview and return any JavaScript errors or console messages. Use this to test your changes and catch runtime errors.",
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
            name: "get_preview_errors",
            description: "Get any JavaScript errors or console.error/warn messages from the most recent preview render. Call after preview_site to check for runtime issues.",
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
            name: "check_dom",
            description: "Statically analyze HTML and JavaScript files to detect DOM element mismatches. Finds when JavaScript references elements (via getElementById, querySelector) that don't exist in HTML. Call this BEFORE finish() to catch common runtime errors.",
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
            name: "get_library_docs",
            description: "Get documentation, CDN links, usage examples, and troubleshooting info for a library. Use this when you need to use a library you're not familiar with, or when debugging library-related errors. Available libraries include: Three.js, Chart.js, GSAP, PixiJS, Leaflet, React, Vue, D3, Tone.js, Zod, Day.js, and more. Also covers Web APIs like localStorage, IndexedDB, and WebAudio.",
            parameters: {
                type: "object",
                properties: {
                    library: {
                        type: "string",
                        description: "Library name (e.g., 'three', 'chart.js', 'gsap', 'localStorage')"
                    },
                    query_type: {
                        type: "string",
                        enum: ["overview", "usage", "errors", "cdn"],
                        description: "Type of information needed: 'overview' (summary), 'usage' (examples), 'errors' (troubleshooting), 'cdn' (import links)"
                    }
                },
                required: ["library"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "search_libraries",
            description: "Search for libraries by name, category, or description. Use when you're not sure which library to use for a task. Categories include: 3d, 2d, animation, charts, audio, maps, ui-framework, styling, web-api, validation, utility.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search query (library name, category, or description)"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "validate_and_preview",
            description: "RECOMMENDED before finish(). Runs comprehensive validation: checks DOM references, validates file syntax, and renders preview to catch runtime errors. Returns all issues in one response. Call this before finish() to ensure your code works.",
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
            name: "finish",
            description: "Signal that all changes are complete and ready to commit. IMPORTANT: Will fail if you haven't called check_dom(), validate_and_preview(), or get_preview_errors() first, or if there are unresolved errors.",
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
 * Validate the project before allowing finish
 * Ensures we have a complete, working website
 * CRITICAL: Now enforces error checking before finish
 */
function validateProjectBeforeFinish() {
    const issues = [];
    const criticalIssues = [];

    // 0. CRITICAL: Check if error validation was performed
    // The agent MUST call check_dom or get_preview_errors before finishing
    if (!validationState.errorCheckPerformed) {
        devLog('finish: BLOCKED - no error check performed');
        return {
            valid: false,
            issues: ['You must check for errors before calling finish()'],
            hint: 'Call check_dom() to verify element IDs match between HTML and JS, or call preview_site() followed by get_preview_errors() to check for runtime errors.'
        };
    }

    // 0b. Check if files were modified AFTER the last error check
    if (validationState.filesModifiedSinceCheck) {
        devLog('finish: BLOCKED - files modified after last error check');
        return {
            valid: false,
            issues: ['Files were modified after the last error check'],
            hint: 'Call check_dom() or get_preview_errors() again to validate your recent changes before calling finish().'
        };
    }

    // 0c. Check if there are UNRESOLVED errors from the last check
    if (validationState.lastDomCheckResult && !validationState.lastDomCheckResult.valid) {
        const domIssues = validationState.lastDomCheckResult.issues || [];
        for (const issue of domIssues) {
            let msg = `UNRESOLVED DOM mismatch in ${issue.file}: ${issue.ids.join(', ')}`;
            if (issue.suggestions && Object.keys(issue.suggestions).length > 0) {
                const firstSuggestion = Object.entries(issue.suggestions)[0];
                msg += ` (did you mean "${firstSuggestion[1][0]}" instead of "${firstSuggestion[0]}"?)`;
            }
            criticalIssues.push(msg);
        }
        devLog('finish: BLOCKED - unresolved DOM mismatches:', domIssues.length);
    }

    // 0d. Check if there are UNRESOLVED preview errors
    if (validationState.lastPreviewErrors && validationState.lastPreviewErrors.hasErrors) {
        const errors = validationState.lastPreviewErrors.errors || [];
        const consoleErrors = validationState.lastPreviewErrors.consoleErrors || [];
        for (const err of errors) {
            criticalIssues.push(`UNRESOLVED runtime error: ${err.message} (line ${err.line || '?'})`);
        }
        for (const err of consoleErrors) {
            criticalIssues.push(`UNRESOLVED console error: ${err.message}`);
        }
        devLog('finish: BLOCKED - unresolved preview errors:', errors.length + consoleErrors.length);
    }

    // If there are unresolved errors from checks, block immediately
    if (criticalIssues.length > 0) {
        return {
            valid: false,
            issues: criticalIssues,
            hint: 'Fix the errors reported by check_dom() or get_preview_errors() before calling finish(). DOM mismatches and runtime errors will cause the site to fail.'
        };
    }

    // 1. Check if index.html exists
    const indexFile = workingFiles.find(f => f.path === 'index.html' || f.path === './index.html');
    if (!indexFile) {
        issues.push('index.html is missing - this is required as the main entry point');
        return {
            valid: false,
            issues,
            hint: 'Create index.html with write_file before calling finish'
        };
    }

    // 2. Check if index.html has meaningful content (not just the starter template)
    const indexContent = indexFile.content;
    const contentLength = indexContent.length;
    const hasBody = /<body[^>]*>[\s\S]*<\/body>/i.test(indexContent);
    const hasContent = indexContent.includes('<h1') || indexContent.includes('<main') ||
                       indexContent.includes('<section') || indexContent.includes('<div class') ||
                       indexContent.includes('<canvas');

    if (contentLength < 500 || !hasBody || !hasContent) {
        issues.push('index.html appears to have minimal content - ensure you\'ve added the requested features');
    }

    // 3. Validate HTML syntax
    const htmlValidation = validateFileSyntax('index.html', indexContent);
    if (!htmlValidation.valid) {
        criticalIssues.push(`index.html has syntax errors: ${htmlValidation.error}`);
    }

    // 4. Check for referenced files that don't exist
    const cssLinks = indexContent.match(/href=["']([^"']+\.css)["']/gi) || [];
    const jsScripts = indexContent.match(/src=["']([^"']+\.js)["']/gi) || [];

    for (const link of cssLinks) {
        const path = link.match(/["']([^"']+)["']/)[1];
        // Skip external URLs
        if (path.startsWith('http') || path.startsWith('//')) continue;
        const exists = workingFiles.some(f => f.path === path || f.path === `./${path}`);
        if (!exists) {
            criticalIssues.push(`CSS file referenced but not found: ${path}`);
        }
    }

    for (const script of jsScripts) {
        const path = script.match(/["']([^"']+)["']/)[1];
        // Skip external URLs and CDN scripts
        if (path.startsWith('http') || path.startsWith('//')) continue;
        const exists = workingFiles.some(f => f.path === path || f.path === `./${path}`);
        if (!exists) {
            criticalIssues.push(`JS file referenced but not found: ${path}`);
        }
    }

    // 5. Validate other files in the project
    for (const file of workingFiles) {
        if (file.path === 'index.html') continue;

        const validation = validateFileSyntax(file.path, file.content);
        if (!validation.valid) {
            criticalIssues.push(`${file.path} has syntax errors: ${validation.error}`);
        }
    }

    // 6. Run a fresh DOM check as final safety (in case validation state got out of sync)
    const domAnalysis = analyzeDomReferences(workingFiles);
    if (!domAnalysis.valid) {
        for (const issue of domAnalysis.issues) {
            let msg = `DOM mismatch in ${issue.file}: ${issue.ids.join(', ')}`;
            if (issue.suggestions && Object.keys(issue.suggestions).length > 0) {
                const firstSuggestion = Object.entries(issue.suggestions)[0];
                msg += ` (did you mean "${firstSuggestion[1][0]}" instead of "${firstSuggestion[0]}"?)`;
            }
            criticalIssues.push(msg);
        }
    }

    // Block on critical issues
    if (criticalIssues.length > 0) {
        devLog('finish: BLOCKED - critical issues:', criticalIssues);
        return {
            valid: false,
            issues: criticalIssues,
            hint: 'Fix these critical issues before calling finish(). DOM mismatches will cause null reference errors at runtime.'
        };
    }

    // Log warnings but allow finish
    if (issues.length > 0) {
        devLog('Finish validation warnings:', issues);
    }

    devLog('finish: Validation passed');
    return { valid: true, warnings: issues };
}

/**
 * Get a human-readable status message for a tool call
 * Used to show the user what the agent is currently doing
 */
function getToolStatusMessage(toolName, args) {
    switch (toolName) {
        case 'read_file':
            return `Reading ${args.path || 'file'}...`;
        case 'read_file_section':
            return `Reading lines ${args.start_line}-${args.end_line} of ${args.path}...`;
        case 'write_file':
            return `Writing ${args.path || 'file'}...`;
        case 'edit_file':
            const editCount = args.edits?.length || 0;
            return `Editing ${args.path} (${editCount} change${editCount !== 1 ? 's' : ''})...`;
        case 'delete_file':
            return `Deleting ${args.path}...`;
        case 'list_files':
            return 'Listing project files...';
        case 'search_files':
            return `Searching for "${args.query?.substring(0, 30) || ''}"...`;
        case 'validate_file':
            return `Validating ${args.path}...`;
        case 'preview_site':
            return 'Rendering preview...';
        case 'get_preview_errors':
            return 'Checking for runtime errors...';
        case 'check_dom':
            return 'Checking DOM element references...';
        case 'get_library_docs':
            return `Looking up ${args.library || 'library'} documentation...`;
        case 'search_libraries':
            return `Searching libraries for "${args.query || ''}"...`;
        case 'validate_and_preview':
            return 'Running comprehensive validation...';
        case 'finish':
            return 'Validating and finishing...';
        default:
            return `Running ${toolName}...`;
    }
}

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
            // Track that files changed - requires new error check before finish
            validationState.filesModifiedSinceCheck = true;
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

            // Track that files changed - requires new error check before finish
            validationState.filesModifiedSinceCheck = true;

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

        case 'preview_site': {
            // Render the current project files in the preview iframe
            try {
                // Clear previous errors before render
                clearPreviewErrors();

                // Render the project
                renderProject(workingFiles);

                // Track that preview was rendered
                validationState.previewRendered = true;
                devLog('preview_site: Preview rendered, awaiting error check');

                // Wait a moment for JavaScript to execute and errors to be captured
                // The actual waiting happens in the agent loop via async delay
                return {
                    success: true,
                    message: 'Preview rendered. Call get_preview_errors after a moment to check for runtime errors.',
                    hint: 'Wait briefly then call get_preview_errors() to see any JavaScript errors.'
                };
            } catch (error) {
                return {
                    success: false,
                    error: `Failed to render preview: ${error.message}`
                };
            }
        }

        case 'get_preview_errors': {
            const errors = getPreviewErrors();

            // Track that error check was performed
            validationState.errorCheckPerformed = true;
            validationState.lastPreviewErrors = errors;
            validationState.filesModifiedSinceCheck = false;
            devLog('get_preview_errors: hasErrors=', errors.hasErrors);

            if (!errors.hasErrors && errors.consoleWarns.length === 0) {
                return {
                    success: true,
                    hasErrors: false,
                    message: 'No errors detected in the preview.',
                    lastRenderTime: errors.lastRenderTime
                };
            }

            // Format errors for the agent
            const formattedErrors = errors.errors.map(e => ({
                type: e.type,
                message: e.message,
                line: e.line,
                column: e.column
            }));

            const formattedConsoleErrors = errors.consoleErrors.map(e => e.message);
            const formattedWarns = errors.consoleWarns.map(e => e.message);

            // Analyze errors for library-specific issues
            const allCode = workingFiles.map(f => f.content).join('\n');
            const allErrorMessages = [
                ...errors.errors.map(e => e.message),
                ...errors.consoleErrors.map(e => e.message)
            ].join(' ');

            const libraryAnalysis = analyzeLibraryError(allErrorMessages, allCode);

            // Build hint with library-specific suggestions
            let hint = errors.hasErrors
                ? 'Fix the errors above. Common issues: null element references, undefined variables, missing DOM elements.'
                : 'Only warnings detected. Consider reviewing if they indicate potential issues.';

            if (libraryAnalysis.hasLibraryRelatedError) {
                const libSuggestions = libraryAnalysis.suggestions.map(s =>
                    `${s.library}: ${s.solution}`
                ).join('\n  ');
                hint += `\n\nLibrary-specific suggestions:\n  ${libSuggestions}`;
                hint += '\n\nUse get_library_docs("' + libraryAnalysis.suggestions[0]?.library + '", "errors") for more troubleshooting info.';
            }

            return {
                success: true,
                hasErrors: errors.hasErrors,
                runtimeErrors: formattedErrors,
                consoleErrors: formattedConsoleErrors,
                warnings: formattedWarns,
                detectedLibraries: libraryAnalysis.detectedLibraries,
                librarySuggestions: libraryAnalysis.suggestions.length > 0 ? libraryAnalysis.suggestions : undefined,
                hint
            };
        }

        case 'check_dom': {
            // Static analysis to detect DOM element mismatches
            const analysis = analyzeDomReferences(workingFiles);

            // Track that error check was performed
            validationState.errorCheckPerformed = true;
            validationState.lastDomCheckResult = analysis;
            validationState.filesModifiedSinceCheck = false;

            if (analysis.valid) {
                devLog('check_dom: All DOM references valid');
                return {
                    success: true,
                    valid: true,
                    message: 'All JavaScript element references match HTML IDs.',
                    htmlIds: analysis.htmlIds,
                    jsIds: analysis.jsIds
                };
            }

            // Format issues with suggestions
            const formattedIssues = analysis.issues.map(issue => {
                let msg = issue.message;
                if (issue.suggestions && Object.keys(issue.suggestions).length > 0) {
                    const suggestionParts = Object.entries(issue.suggestions)
                        .map(([missing, similar]) => `"${missing}" -> did you mean "${similar[0]}"?`)
                        .join('; ');
                    msg += ` Suggestions: ${suggestionParts}`;
                }
                return {
                    file: issue.file,
                    missingIds: issue.ids,
                    message: msg
                };
            });

            devLog('check_dom: Found DOM mismatches:', formattedIssues.length, 'issues');

            return {
                success: true,
                valid: false,
                issues: formattedIssues,
                htmlIds: analysis.htmlIds,
                jsIds: analysis.jsIds,
                hint: 'CRITICAL: JavaScript references elements that do not exist in HTML. This will cause "Cannot read properties of null" errors. You MUST fix these before calling finish().'
            };
        }

        case 'get_library_docs': {
            const queryType = args.query_type || 'overview';
            const docs = formatLibraryDocs(args.library, queryType);
            return {
                success: true,
                documentation: docs,
                hint: 'Use this documentation to implement the library correctly. Check "errors" query_type if you encounter issues.'
            };
        }

        case 'search_libraries': {
            const results = searchLibraries(args.query);
            if (results.length === 0) {
                // Also try category search
                const categories = getCategories();
                return {
                    success: true,
                    results: [],
                    message: `No libraries found matching "${args.query}".`,
                    availableCategories: categories,
                    hint: `Try searching by category: ${categories.join(', ')}`
                };
            }
            return {
                success: true,
                results: results.map(lib => ({
                    id: lib.id,
                    name: lib.name,
                    category: lib.category,
                    description: lib.description
                })),
                message: `Found ${results.length} library(ies). Use get_library_docs for detailed information.`
            };
        }

        case 'validate_and_preview': {
            // Comprehensive validation combining DOM check, syntax validation, and preview
            devLog('validate_and_preview: Running comprehensive validation...');
            const allIssues = [];
            const warnings = [];

            // 1. DOM reference analysis (static)
            const domAnalysis = analyzeDomReferences(workingFiles);
            if (!domAnalysis.valid) {
                for (const issue of domAnalysis.issues) {
                    let msg = `DOM mismatch in ${issue.file}: ${issue.ids.join(', ')}`;
                    if (issue.suggestions && Object.keys(issue.suggestions).length > 0) {
                        const firstSuggestion = Object.entries(issue.suggestions)[0];
                        msg += ` (did you mean "${firstSuggestion[1][0]}" instead of "${firstSuggestion[0]}"?)`;
                    }
                    allIssues.push({ type: 'dom', message: msg });
                }
            }

            // 2. Syntax validation for all files
            for (const file of workingFiles) {
                const validation = validateFileSyntax(file.path, file.content);
                if (!validation.valid) {
                    allIssues.push({ type: 'syntax', file: file.path, message: validation.error });
                }
                if (validation.warnings) {
                    warnings.push(...validation.warnings.map(w => ({ file: file.path, message: w })));
                }
            }

            // 3. Check for missing referenced files
            const indexFile = workingFiles.find(f => f.path === 'index.html');
            if (indexFile) {
                const cssLinks = indexFile.content.match(/href=["']([^"']+\.css)["']/gi) || [];
                const jsScripts = indexFile.content.match(/src=["']([^"']+\.js)["']/gi) || [];

                for (const link of cssLinks) {
                    const path = link.match(/["']([^"']+)["']/)[1];
                    if (path.startsWith('http') || path.startsWith('//')) continue;
                    const exists = workingFiles.some(f => f.path === path || f.path === `./${path}`);
                    if (!exists) {
                        allIssues.push({ type: 'missing', message: `CSS file referenced but not found: ${path}` });
                    }
                }

                for (const script of jsScripts) {
                    const path = script.match(/["']([^"']+)["']/)[1];
                    if (path.startsWith('http') || path.startsWith('//')) continue;
                    const exists = workingFiles.some(f => f.path === path || f.path === `./${path}`);
                    if (!exists) {
                        allIssues.push({ type: 'missing', message: `JS file referenced but not found: ${path}` });
                    }
                }
            } else {
                allIssues.push({ type: 'missing', message: 'index.html is missing' });
            }

            // 4. Render preview and capture errors
            try {
                clearPreviewErrors();
                renderProject(workingFiles);
                validationState.previewRendered = true;

                // Wait a bit for JS to execute (in browser context)
                // Note: In actual execution, errors are captured asynchronously
                // The agent should call get_preview_errors() after for runtime errors
            } catch (err) {
                allIssues.push({ type: 'render', message: `Preview render failed: ${err.message}` });
            }

            // Track validation state
            validationState.errorCheckPerformed = true;
            validationState.lastDomCheckResult = domAnalysis;
            validationState.filesModifiedSinceCheck = false;

            devLog('validate_and_preview: Found', allIssues.length, 'issues,', warnings.length, 'warnings');

            if (allIssues.length === 0) {
                return {
                    success: true,
                    valid: true,
                    message: 'All validations passed! Preview rendered. You can now call finish().',
                    warnings: warnings.length > 0 ? warnings : undefined,
                    hint: 'Call get_preview_errors() if you want to check for runtime JavaScript errors, or proceed to finish().'
                };
            }

            return {
                success: true,
                valid: false,
                issues: allIssues,
                warnings: warnings.length > 0 ? warnings : undefined,
                hint: 'Fix the issues above before calling finish(). DOM mismatches will cause null reference errors. After fixing, call validate_and_preview() again to verify.'
            };
        }

        case 'finish': {
            devLog('finish: Agent attempting to finish...');
            devLog('finish: Validation state:', {
                errorCheckPerformed: validationState.errorCheckPerformed,
                previewRendered: validationState.previewRendered,
                filesModifiedSinceCheck: validationState.filesModifiedSinceCheck,
                hasUnresolvedDomIssues: validationState.lastDomCheckResult && !validationState.lastDomCheckResult.valid,
                hasUnresolvedPreviewErrors: validationState.lastPreviewErrors && validationState.lastPreviewErrors.hasErrors
            });

            // Pre-finish validation: ensure we have a complete, valid project
            const validation = validateProjectBeforeFinish();

            if (!validation.valid) {
                devLog('finish: BLOCKED -', validation.issues.length, 'issues');
                return {
                    success: false,
                    error: 'Cannot finish yet - validation failed',
                    issues: validation.issues,
                    hint: validation.hint,
                    validationState: {
                        errorCheckPerformed: validationState.errorCheckPerformed,
                        filesModifiedSinceCheck: validationState.filesModifiedSinceCheck
                    }
                };
            }

            devLog('finish: SUCCESS - project validated');
            return { success: true, finished: true, summary: args.summary };
        }

        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
}

/**
 * Build the agent system prompt with model-specific optimizations
 * Uses the unified prompts.js system with agent-specific enhancements
 */
function buildAgentSystemPrompt(isNewProject, modelProfile, userPrompt = '') {
    const modelId = modelProfile?.modelId || state.settings.openRouterModel;
    const style = modelProfile?.promptStyle || 'markdown';
    const mode = isNewProject ? 'CREATE' : 'MODIFY';

    // Get the base agent system prompt from prompts.js
    let systemPrompt = buildAgentSystemPromptBase(modelId);

    // Add mode-specific workflow instructions
    const workflowInstructions = isNewProject
        ? `
WORKFLOW FOR NEW PROJECT:
1. Read the starter index.html template first (read_file)
2. Plan what files you need: index.html (required), styles.css, script.js
3. Build the complete site - don't stop after just one file
4. Use write_file for new files, edit_file for modifications
5. Validate each file after creating/editing (validate_file)
6. **MANDATORY ERROR CHECK**: Before calling finish(), you MUST:
   - Call check_dom() to detect element ID mismatches between HTML and JS
   - OR call preview_site() then get_preview_errors() for runtime errors
7. If ANY errors are reported, FIX THEM and check again
8. finish() will REJECT if errors exist or if you haven't checked for errors
9. Only call finish() when check_dom() shows valid: true`
        : `
WORKFLOW FOR MODIFICATIONS:
1. Use list_files() to see current project structure
2. Read relevant files to understand current state
3. Plan your changes - what files need modification?
4. Use edit_file for small changes, write_file for major rewrites
5. Validate changes with validate_file
6. **MANDATORY ERROR CHECK**: Before calling finish(), you MUST:
   - Call check_dom() to verify element IDs match between HTML and JS
   - This catches errors like "game" vs "game-container" mismatches
7. If check_dom shows issues, FIX THEM and run check_dom() again
8. finish() will REJECT if errors exist or if you haven't checked for errors
9. Call finish() only when check_dom() shows valid: true`;

    // Add context-aware technical notes
    const technicalNotes = buildAgentTechnicalNotes(userPrompt);

    // Completion requirements - CRITICAL for preventing partial output
    const completionRequirements = `
COMPLETION REQUIREMENTS (CRITICAL - READ CAREFULLY):

**finish() WILL BE REJECTED if:**
1. You haven't called check_dom() or get_preview_errors() first
2. Files were modified after your last error check
3. Any DOM mismatches exist (JS references elements not in HTML)
4. Any runtime errors exist from get_preview_errors()
5. index.html is missing or references non-existent files

**REQUIRED WORKFLOW before finish():**
1. After writing all files, call check_dom()
2. If check_dom() shows valid: false, fix ALL issues
3. Call check_dom() AGAIN to verify fixes
4. Only call finish() when check_dom() shows valid: true

**Common errors that will BLOCK finish():**
- "gameContainer" in JS but "game-container" in HTML -> IDs must match EXACTLY
- "canvas" vs "game-canvas" -> be consistent
- Element IDs are CASE-SENSITIVE: "myDiv" ≠ "mydiv"
- getElementById('score') when HTML has id="scoreDisplay"

**For libraries (Three.js, Chart.js, etc.):**
- Use get_library_docs() for correct import syntax
- ES modules require type="module" on script tags
- Use import maps for bare imports like 'three'

Do NOT call finish() until you have confirmed no errors exist!`;

    // Build the final prompt based on style
    if (style === 'xml-tags') {
        systemPrompt += `

<mode>${mode}</mode>

<workflow>${workflowInstructions}
</workflow>

<completion_requirements>${completionRequirements}
</completion_requirements>
${technicalNotes ? `\n<context_specific>\n${technicalNotes}\n</context_specific>` : ''}`;
    } else {
        systemPrompt += `

### Mode: ${mode}
${workflowInstructions}

### Completion Requirements
${completionRequirements}
${technicalNotes ? `\n### Context-Specific Guidelines\n${technicalNotes}` : ''}`;
    }

    return systemPrompt;
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
    // For new projects, start with minimal HTML/CSS/JS files so models have a foundation
    workingFiles = isNewProject ? STARTER_FILES.map(f => ({ ...f })) : JSON.parse(JSON.stringify(currentFiles));
    iterationCount = 0;

    // Reset validation tracking for this agent run
    validationState = {
        errorCheckPerformed: false,
        previewRendered: false,
        lastDomCheckResult: null,
        lastPreviewErrors: null,
        filesModifiedSinceCheck: true  // Start true since we have initial files
    };

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
        const fileCount = workingFiles.length;
        const iterationStatus = `Iteration ${iterationCount}/${MAX_ITERATIONS} (${fileCount} files)`;
        thinking.setStatus('thinking', iterationStatus);
        thinking.log('iteration', `Starting iteration ${iterationCount} - ${fileCount} files in project`);
        devLog(`\n${'='.repeat(50)}`);
        devLog(`AGENT ITERATION ${iterationCount}/${MAX_ITERATIONS}`);
        devLog(`Files: ${workingFiles.map(f => f.path).join(', ') || 'none'}`);
        devLog(`Validation state: errorCheck=${validationState.errorCheckPerformed}, modifiedSinceCheck=${validationState.filesModifiedSinceCheck}`);
        devLog(`${'='.repeat(50)}`);

        try {
            const response = await callOpenRouterWithTools(messages, key);

            // Check for tool calls
            const toolCalls = response.tool_calls;
            devLog(`API response: ${toolCalls?.length || 0} tool calls, content: ${response.content ? 'yes' : 'no'}`);

            if (toolCalls && toolCalls.length > 0) {
                thinking.log('info', `Agent calling ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''}: ${toolCalls.map(t => t.function.name).join(', ')}`);

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

                    // Show human-readable status for each tool
                    const toolStatus = getToolStatusMessage(toolName, toolArgs);
                    thinking.setStatus('thinking', toolStatus);
                    thinking.log('tool', `${toolName}(${JSON.stringify(toolArgs).substring(0, 80)}...)`);
                    devLog(`Agent tool: ${toolName}`, toolArgs);

                    const result = executeTool(toolName, toolArgs);

                    // Log tool results for verbose output
                    if (result.success === false) {
                        devLog(`Tool ${toolName} FAILED:`, result.error || result.issues);
                        thinking.log('warning', `${toolName} failed: ${result.error || 'validation issues'}`);
                    } else {
                        devLog(`Tool ${toolName} result:`, result);
                    }

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
                        devLog('Agent finished successfully!');
                        devLog('Summary:', finalSummary);
                        thinking.log('complete', 'Agent finished successfully');
                    } else if (toolName === 'finish' && !result.success) {
                        // Log when finish was blocked
                        devLog('finish() BLOCKED:', result.issues);
                        thinking.log('warning', `Finish blocked: ${result.issues?.[0] || 'validation failed'}`);
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
            ? otherHtmlFiles.map(f => `<li><a href="${f.path}">${f.path}</a></li>`).join('\n    ')
            : '<li>No additional pages</li>';

        const fallbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 1rem; }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; }
        ul { margin: 1rem 0; padding-left: 1.5rem; }
        li { margin: 0.5rem 0; }
        a { color: #3b82f6; }
        .note { background: #fef3c7; border: 1px solid #fcd34d; padding: 1rem; border-radius: 0.5rem; margin-top: 2rem; }
    </style>
</head>
<body>
    <h1>Project Files</h1>
    <p>The AI created the following files:</p>
    <ul>
    ${links}
    </ul>
    <div class="note">
        <p>Note: The AI didn't create a proper index.html. You may want to regenerate.</p>
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

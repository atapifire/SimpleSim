/**
 * Token Management Module
 * Estimates tokens, detects large files, and manages context efficiently
 */

import { state } from './state.js';
import { devLog } from './thinking.js';

// Approximate tokens per character (conservative estimate)
// Most tokenizers average ~4 chars per token for code
const CHARS_PER_TOKEN = 4;

// Thresholds
const WARNING_TOKENS = 5000;  // Show warning at 5k tokens
const CRITICAL_TOKENS = 10000; // Critical at 10k tokens
const MAX_CONTEXT_TOKENS = 30000; // Max we want to send to model

/**
 * Estimate token count for a string
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Analyze project files and return health metrics
 */
export function analyzeProjectHealth(files) {
    if (!files || !Array.isArray(files)) {
        return { status: 'empty', files: [], totalTokens: 0, warnings: [] };
    }

    const fileAnalysis = files.map(file => {
        const tokens = estimateTokens(file.content);
        const lines = file.content.split('\n').length;

        let status = 'ok';
        if (tokens >= CRITICAL_TOKENS) {
            status = 'critical';
        } else if (tokens >= WARNING_TOKENS) {
            status = 'warning';
        }

        return {
            path: file.path,
            tokens,
            lines,
            chars: file.content.length,
            status
        };
    });

    const totalTokens = fileAnalysis.reduce((sum, f) => sum + f.tokens, 0);
    const warnings = fileAnalysis.filter(f => f.status !== 'ok');

    // Determine overall status
    let overallStatus = 'healthy';
    if (warnings.some(f => f.status === 'critical')) {
        overallStatus = 'critical';
    } else if (warnings.length > 0) {
        overallStatus = 'warning';
    }

    devLog('Project health analysis:', {
        totalTokens,
        fileCount: files.length,
        warnings: warnings.length,
        status: overallStatus
    });

    return {
        status: overallStatus,
        files: fileAnalysis,
        totalTokens,
        warnings,
        contextFits: totalTokens < MAX_CONTEXT_TOKENS
    };
}

/**
 * Generate a code map (structure without full content) for large projects
 * This dramatically reduces token usage while maintaining context
 */
export function generateCodeMap(files) {
    if (!files || !Array.isArray(files)) return '';

    let codeMap = '# PROJECT STRUCTURE\n\n';

    for (const file of files) {
        const tokens = estimateTokens(file.content);
        codeMap += `## ${file.path} (${tokens} tokens, ${file.content.split('\n').length} lines)\n`;

        // Extract structure based on file type
        if (file.path.endsWith('.html')) {
            codeMap += extractHtmlStructure(file.content);
        } else if (file.path.endsWith('.css')) {
            codeMap += extractCssStructure(file.content);
        } else if (file.path.endsWith('.js')) {
            codeMap += extractJsStructure(file.content);
        } else {
            codeMap += `- File content: ${tokens} tokens\n`;
        }
        codeMap += '\n';
    }

    return codeMap;
}

/**
 * Extract HTML structure (tags, ids, classes)
 */
function extractHtmlStructure(content) {
    let structure = '';

    // Extract title
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
        structure += `- Title: "${titleMatch[1]}"\n`;
    }

    // Extract main structural elements
    const sections = content.match(/<(header|nav|main|section|article|aside|footer)[^>]*>/gi) || [];
    if (sections.length > 0) {
        structure += `- Sections: ${sections.map(s => s.match(/<(\w+)/)[1]).join(', ')}\n`;
    }

    // Extract IDs
    const ids = content.match(/id=["']([^"']+)["']/gi) || [];
    if (ids.length > 0) {
        const idNames = ids.map(id => id.match(/id=["']([^"']+)["']/i)[1]);
        structure += `- IDs: ${idNames.slice(0, 10).join(', ')}${idNames.length > 10 ? '...' : ''}\n`;
    }

    // Extract forms
    const forms = content.match(/<form[^>]*>/gi) || [];
    if (forms.length > 0) {
        structure += `- Forms: ${forms.length}\n`;
    }

    // Extract scripts
    const scripts = content.match(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi) || [];
    if (scripts.length > 0) {
        structure += `- External scripts: ${scripts.length}\n`;
    }

    return structure || '- Basic HTML document\n';
}

/**
 * Extract CSS structure (selectors, media queries)
 */
function extractCssStructure(content) {
    let structure = '';

    // Count rules
    const rules = content.match(/[^{}]+\{[^{}]*\}/g) || [];
    structure += `- CSS rules: ${rules.length}\n`;

    // Extract media queries
    const mediaQueries = content.match(/@media[^{]+/g) || [];
    if (mediaQueries.length > 0) {
        structure += `- Media queries: ${mediaQueries.length}\n`;
    }

    // Extract keyframes
    const keyframes = content.match(/@keyframes\s+[\w-]+/g) || [];
    if (keyframes.length > 0) {
        structure += `- Animations: ${keyframes.map(k => k.replace('@keyframes ', '')).join(', ')}\n`;
    }

    // Extract CSS variables
    const variables = content.match(/--[\w-]+:/g) || [];
    if (variables.length > 0) {
        structure += `- CSS variables: ${variables.length}\n`;
    }

    return structure || '- Stylesheet\n';
}

/**
 * Extract JavaScript structure (functions, classes, exports)
 */
function extractJsStructure(content) {
    let structure = '';

    // Extract function declarations
    const functions = content.match(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*:\s*(?:async\s*)?function)/g) || [];
    if (functions.length > 0) {
        structure += `- Functions: ${functions.length}\n`;
        // List first few
        const funcNames = functions.slice(0, 5).map(f => {
            const match = f.match(/(?:function\s+|const\s+)(\w+)/);
            return match ? match[1] : f.split(/[(:=]/)[0].trim();
        });
        structure += `  - ${funcNames.join(', ')}${functions.length > 5 ? '...' : ''}\n`;
    }

    // Extract classes
    const classes = content.match(/class\s+(\w+)/g) || [];
    if (classes.length > 0) {
        structure += `- Classes: ${classes.map(c => c.replace('class ', '')).join(', ')}\n`;
    }

    // Extract imports
    const imports = content.match(/import\s+.*from\s+['"][^'"]+['"]/g) || [];
    if (imports.length > 0) {
        structure += `- Imports: ${imports.length}\n`;
    }

    // Extract exports
    const exports = content.match(/export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g) || [];
    if (exports.length > 0) {
        structure += `- Exports: ${exports.length}\n`;
    }

    // Extract event listeners
    const listeners = content.match(/addEventListener\s*\(\s*['"](\w+)['"]/g) || [];
    if (listeners.length > 0) {
        const events = listeners.map(l => l.match(/['"](\w+)['"]/)[1]);
        structure += `- Event listeners: ${[...new Set(events)].join(', ')}\n`;
    }

    return structure || '- JavaScript module\n';
}

/**
 * Build refactoring suggestions for large files
 */
export function getRefactoringSuggestions(files) {
    const health = analyzeProjectHealth(files);
    const suggestions = [];

    for (const file of health.files) {
        if (file.status === 'critical') {
            suggestions.push({
                file: file.path,
                severity: 'critical',
                tokens: file.tokens,
                suggestion: getFileSplitSuggestion(file.path, files.find(f => f.path === file.path)?.content)
            });
        } else if (file.status === 'warning') {
            suggestions.push({
                file: file.path,
                severity: 'warning',
                tokens: file.tokens,
                suggestion: `Consider splitting ${file.path} into smaller modules`
            });
        }
    }

    return suggestions;
}

/**
 * Generate specific split suggestions based on file type
 */
function getFileSplitSuggestion(path, content) {
    if (!content) return 'Split into smaller files';

    if (path.endsWith('.html')) {
        return 'Consider extracting reusable components or splitting into partials';
    }

    if (path.endsWith('.css')) {
        const suggestions = [];
        if (content.includes('@media')) suggestions.push('responsive.css');
        if (content.includes('@keyframes')) suggestions.push('animations.css');
        if (content.includes(':root') || content.includes('--')) suggestions.push('variables.css');
        suggestions.push('components.css', 'layout.css');
        return `Split into: ${suggestions.slice(0, 3).join(', ')}`;
    }

    if (path.endsWith('.js')) {
        const suggestions = [];
        if (content.includes('addEventListener')) suggestions.push('events.js');
        if (content.includes('fetch(') || content.includes('async')) suggestions.push('api.js');
        if (content.includes('class ')) suggestions.push('classes.js');
        suggestions.push('utils.js', 'main.js');
        return `Split into: ${suggestions.slice(0, 3).join(', ')}`;
    }

    return 'Split into smaller, focused modules';
}

/**
 * Build the refactoring prompt for the AI
 */
export function buildRefactoringPrompt(files, targetFile) {
    const file = files.find(f => f.path === targetFile);
    if (!file) return null;

    const health = analyzeProjectHealth(files);
    const fileInfo = health.files.find(f => f.path === targetFile);

    return `REFACTORING REQUEST

The file "${targetFile}" has grown too large (${fileInfo.tokens} tokens, ${fileInfo.lines} lines).
Please refactor it into multiple smaller, well-organized files.

CURRENT FILE:
=== ${targetFile} ===
${file.content}

INSTRUCTIONS:
1. Split this file into 2-4 smaller, focused files
2. Each new file should have a single responsibility
3. Update any imports/references as needed
4. Maintain all existing functionality
5. Use clear, descriptive file names

Return the refactored files in the standard JSON format with action: "add" for new files and action: "delete" for the original large file (or action: "modify" if keeping a smaller version).`;
}

/**
 * Format token count for display
 */
export function formatTokenCount(tokens) {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
}

/**
 * Get status color class for UI
 */
export function getStatusColor(status) {
    switch (status) {
        case 'critical': return 'text-red-400 bg-red-900/30 border-red-900/50';
        case 'warning': return 'text-yellow-400 bg-yellow-900/30 border-yellow-900/50';
        case 'healthy': return 'text-green-400 bg-green-900/30 border-green-900/50';
        default: return 'text-gray-400 bg-gray-900/30 border-gray-700/50';
    }
}

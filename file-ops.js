/**
 * Enhanced File Operations
 *
 * Provides surgical file editing without full rewrites, supporting:
 * - Search/replace edits for small changes
 * - Full file replacement when needed
 * - File validation (HTML, CSS, JS syntax checking)
 * - Edit verification to ensure changes applied correctly
 */

import { devLog, devError } from './thinking.js';

// File action types
export const FILE_ACTIONS = {
    CREATE: 'create',      // New file
    REPLACE: 'replace',    // Full file replacement
    EDIT: 'edit',          // Search/replace operations
    DELETE: 'delete',      // Remove file
    RENAME: 'rename'       // Move/rename file
};

/**
 * Apply search/replace edits to file content
 * @param {string} fileContent - Original file content
 * @param {Array<{search: string, replace: string}>} edits - Array of edit operations
 * @returns {{success: boolean, content?: string, error?: string, failedEdit?: object}}
 */
export function applyEdits(fileContent, edits) {
    if (!edits || !Array.isArray(edits) || edits.length === 0) {
        return { success: false, error: 'No edits provided' };
    }

    let content = fileContent;

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];

        if (!edit.search || typeof edit.search !== 'string') {
            return {
                success: false,
                error: `Edit ${i + 1}: Missing or invalid search string`,
                failedEdit: edit
            };
        }

        if (typeof edit.replace !== 'string') {
            return {
                success: false,
                error: `Edit ${i + 1}: Missing or invalid replace string`,
                failedEdit: edit
            };
        }

        // Check if search string exists
        const searchIndex = content.indexOf(edit.search);

        if (searchIndex === -1) {
            // Search string not found - try fuzzy matching
            const fuzzyResult = fuzzyFindSearch(content, edit.search);

            if (fuzzyResult.found) {
                devLog(`Edit ${i + 1}: Using fuzzy match for search string`);
                content = content.substring(0, fuzzyResult.index) +
                          edit.replace +
                          content.substring(fuzzyResult.index + fuzzyResult.matchLength);
            } else {
                return {
                    success: false,
                    error: `Edit ${i + 1}: Search string not found in file`,
                    failedEdit: edit,
                    suggestion: fuzzyResult.suggestion
                };
            }
        } else {
            // Check for multiple occurrences
            const secondOccurrence = content.indexOf(edit.search, searchIndex + 1);

            if (secondOccurrence !== -1) {
                return {
                    success: false,
                    error: `Edit ${i + 1}: Search string found multiple times. Add more context to make it unique.`,
                    failedEdit: edit,
                    occurrences: countOccurrences(content, edit.search)
                };
            }

            // Apply the edit
            content = content.substring(0, searchIndex) +
                      edit.replace +
                      content.substring(searchIndex + edit.search.length);
        }
    }

    return { success: true, content };
}

/**
 * Validate that all edits can be applied (dry run)
 * @param {string} fileContent - Original file content
 * @param {Array<{search: string, replace: string}>} edits - Array of edit operations
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEdits(fileContent, edits) {
    const errors = [];

    if (!edits || !Array.isArray(edits)) {
        return { valid: false, errors: ['Edits must be an array'] };
    }

    let simulatedContent = fileContent;

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];

        if (!edit.search) {
            errors.push(`Edit ${i + 1}: Missing search string`);
            continue;
        }

        const searchIndex = simulatedContent.indexOf(edit.search);

        if (searchIndex === -1) {
            errors.push(`Edit ${i + 1}: Search string not found: "${truncate(edit.search, 50)}"`);
        } else {
            const secondOccurrence = simulatedContent.indexOf(edit.search, searchIndex + 1);
            if (secondOccurrence !== -1) {
                errors.push(`Edit ${i + 1}: Search string found ${countOccurrences(simulatedContent, edit.search)} times - must be unique`);
            } else {
                // Simulate the edit for subsequent checks
                simulatedContent = simulatedContent.substring(0, searchIndex) +
                                   (edit.replace || '') +
                                   simulatedContent.substring(searchIndex + edit.search.length);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Merge AI response with existing files, supporting edit action
 * @param {Array<{path: string, content: string}>} existingFiles - Current project files
 * @param {Array<{path: string, action?: string, content?: string, edits?: Array}>} changes - AI response files
 * @returns {{files: Array, applied: string[], errors: string[]}}
 */
export function mergeWithEdits(existingFiles, changes) {
    const result = [...existingFiles];
    const applied = [];
    const errors = [];

    for (const change of changes) {
        const action = change.action || 'modify';
        const existingIndex = result.findIndex(f => f.path === change.path);

        switch (action) {
            case 'delete':
                if (existingIndex !== -1) {
                    result.splice(existingIndex, 1);
                    applied.push(`Deleted: ${change.path}`);
                } else {
                    errors.push(`Delete failed: ${change.path} not found`);
                }
                break;

            case 'create':
            case 'add':
                if (existingIndex !== -1) {
                    errors.push(`Create failed: ${change.path} already exists (use 'replace' or 'edit')`);
                } else {
                    result.push({ path: change.path, content: change.content });
                    applied.push(`Created: ${change.path}`);
                }
                break;

            case 'edit':
                if (existingIndex === -1) {
                    errors.push(`Edit failed: ${change.path} not found`);
                } else if (!change.edits || !Array.isArray(change.edits)) {
                    errors.push(`Edit failed: ${change.path} has no edits array`);
                } else {
                    const editResult = applyEdits(result[existingIndex].content, change.edits);
                    if (editResult.success) {
                        result[existingIndex] = { path: change.path, content: editResult.content };
                        applied.push(`Edited: ${change.path} (${change.edits.length} changes)`);
                    } else {
                        errors.push(`Edit failed: ${change.path} - ${editResult.error}`);
                    }
                }
                break;

            case 'replace':
            case 'modify':
            default:
                if (existingIndex !== -1) {
                    result[existingIndex] = { path: change.path, content: change.content };
                    applied.push(`Modified: ${change.path}`);
                } else {
                    result.push({ path: change.path, content: change.content });
                    applied.push(`Added: ${change.path}`);
                }
                break;
        }
    }

    return { files: result, applied, errors };
}

/**
 * Validate file syntax based on file extension
 * @param {string} path - File path
 * @param {string} content - File content
 * @param {boolean} autoRepair - Whether to attempt auto-repair for HTML (default: false for validation only)
 * @returns {{valid: boolean, error?: string, warnings: string[], content?: string, repaired?: boolean}}
 */
export function validateFileSyntax(path, content, autoRepair = false) {
    const warnings = [];
    const ext = path.split('.').pop()?.toLowerCase();

    if (!content || typeof content !== 'string') {
        return { valid: false, error: 'Empty or invalid content', warnings };
    }

    switch (ext) {
        case 'html':
        case 'htm':
            if (autoRepair) {
                return validateAndRepairHTML(content, true);
            }
            return validateHTML(content);

        case 'css':
            return validateCSS(content);

        case 'js':
        case 'mjs':
            return validateJS(content);

        case 'json':
            return validateJSON(content);

        default:
            return { valid: true, warnings: ['Unknown file type - skipping syntax validation'] };
    }
}

/**
 * Validate and repair all files in a project
 * @param {Array<{path: string, content: string}>} files - Project files
 * @returns {{files: Array, repairs: Array<{path: string, repairs: string[]}>}}
 */
export function validateAndRepairFiles(files) {
    const repairedFiles = [];
    const allRepairs = [];

    for (const file of files) {
        const ext = file.path.split('.').pop()?.toLowerCase();

        if (ext === 'html' || ext === 'htm') {
            const result = validateAndRepairHTML(file.content, true);

            if (result.repaired) {
                repairedFiles.push({ path: file.path, content: result.content });
                allRepairs.push({ path: file.path, repairs: result.repairs });
                devLog(`Auto-repaired ${file.path}: ${result.repairs.join(', ')}`);
            } else {
                repairedFiles.push(file);
            }
        } else {
            repairedFiles.push(file);
        }
    }

    return { files: repairedFiles, repairs: allRepairs };
}

/**
 * Verify that edits were actually applied
 * @param {string} originalContent - Content before edits
 * @param {string} newContent - Content after edits
 * @param {Array<{search: string, replace: string}>} edits - Applied edits
 * @returns {{success: boolean, issues: string[]}}
 */
export function verifyEditsApplied(originalContent, newContent, edits) {
    const issues = [];

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];

        // Search string should no longer exist (unless replace contains it)
        if (!edit.replace.includes(edit.search) && newContent.includes(edit.search)) {
            issues.push(`Edit ${i + 1}: Search string still present after edit: "${truncate(edit.search, 30)}"`);
        }

        // Replace string should exist
        if (edit.replace && !newContent.includes(edit.replace)) {
            issues.push(`Edit ${i + 1}: Replacement not found in result: "${truncate(edit.replace, 30)}"`);
        }
    }

    return { success: issues.length === 0, issues };
}

/**
 * Detect potential truncation in file content
 * @param {string} originalContent - Original content
 * @param {string} newContent - New/modified content
 * @returns {{truncated: boolean, reduction: number, warning?: string}}
 */
export function detectTruncation(originalContent, newContent) {
    if (!originalContent || !newContent) {
        return { truncated: false, reduction: 0 };
    }

    const originalLength = originalContent.length;
    const newLength = newContent.length;
    const reduction = ((originalLength - newLength) / originalLength) * 100;

    // If content reduced by more than 50%, it's likely truncation
    if (reduction > 50) {
        return {
            truncated: true,
            reduction: Math.round(reduction),
            warning: `File content reduced by ${Math.round(reduction)}% - possible truncation`
        };
    }

    return { truncated: false, reduction: Math.round(reduction) };
}

/**
 * Check for common file issues that indicate generation problems
 * @param {Array<{path: string, content: string}>} originalFiles
 * @param {Array<{path: string, content: string, action?: string}>} newFiles
 * @param {Object} options - Options object
 * @param {boolean} options.autoRepair - Whether to auto-repair HTML files (default: false)
 * @returns {{valid: boolean, issues: string[], files?: Array, repairs?: Array}}
 */
export function validateGenerationResult(originalFiles, newFiles, options = {}) {
    const issues = [];
    const autoRepair = options.autoRepair || false;

    // Check for unexpected file disappearances
    for (const original of originalFiles) {
        const stillExists = newFiles.find(f => f.path === original.path);
        const wasDeleted = newFiles.find(f => f.path === original.path && f.action === 'delete');

        if (!stillExists && !wasDeleted) {
            issues.push(`File "${original.path}" disappeared without explicit delete action`);
        }
    }

    // Check for truncation
    for (const newFile of newFiles) {
        if (newFile.action === 'replace' || newFile.action === 'modify' || !newFile.action) {
            const original = originalFiles.find(f => f.path === newFile.path);
            if (original) {
                const truncCheck = detectTruncation(original.content, newFile.content);
                if (truncCheck.truncated) {
                    issues.push(truncCheck.warning);
                }
            }
        }
    }

    // Validate syntax for each new file (without repair first)
    for (const file of newFiles) {
        if (file.content) {
            const syntaxResult = validateFileSyntax(file.path, file.content, false);
            if (!syntaxResult.valid) {
                issues.push(`File "${file.path}" has syntax error: ${syntaxResult.error}`);
            }
        }
    }

    // If we have issues and autoRepair is enabled, try to repair
    if (issues.length > 0 && autoRepair) {
        const repairResult = validateAndRepairFiles(newFiles);

        if (repairResult.repairs.length > 0) {
            // Re-validate after repair
            const postRepairIssues = [];
            for (const file of repairResult.files) {
                if (file.content) {
                    const syntaxResult = validateFileSyntax(file.path, file.content, false);
                    if (!syntaxResult.valid) {
                        postRepairIssues.push(`File "${file.path}" has syntax error: ${syntaxResult.error}`);
                    }
                }
            }

            return {
                valid: postRepairIssues.length === 0,
                issues: postRepairIssues,
                originalIssues: issues,
                files: repairResult.files,
                repairs: repairResult.repairs,
                repaired: true
            };
        }
    }

    return { valid: issues.length === 0, issues };
}

// ============================================
// Helper Functions
// ============================================

function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '...';
}

function countOccurrences(str, search) {
    let count = 0;
    let pos = 0;
    while ((pos = str.indexOf(search, pos)) !== -1) {
        count++;
        pos += 1;
    }
    return count;
}

function fuzzyFindSearch(content, search) {
    // Try to find with normalized whitespace
    const normalizedContent = content.replace(/\s+/g, ' ');
    const normalizedSearch = search.replace(/\s+/g, ' ');

    const index = normalizedContent.indexOf(normalizedSearch);
    if (index !== -1) {
        // Find the actual position in original content
        // This is approximate - would need more sophisticated matching for production
        return { found: true, index, matchLength: search.length };
    }

    // Try trimmed lines
    const searchLines = search.trim().split('\n').map(l => l.trim()).filter(l => l);
    if (searchLines.length > 0) {
        const firstLine = searchLines[0];
        const contentLines = content.split('\n');

        for (let i = 0; i < contentLines.length; i++) {
            if (contentLines[i].trim() === firstLine) {
                // Found potential match - check subsequent lines
                let match = true;
                for (let j = 1; j < searchLines.length && i + j < contentLines.length; j++) {
                    if (contentLines[i + j].trim() !== searchLines[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    return {
                        found: true,
                        index: content.indexOf(contentLines[i]),
                        matchLength: search.length,
                        suggestion: 'Matched with normalized whitespace'
                    };
                }
            }
        }
    }

    // Generate suggestion for user
    const searchPreview = truncate(search.trim(), 40);
    return {
        found: false,
        suggestion: `Could not find "${searchPreview}". Check for whitespace differences or try including more context.`
    };
}

/**
 * Self-closing tags that don't need closing tags
 */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Common LLM truncation patterns
 */
/**
 * Common LLM truncation patterns
 * These are designed to catch LLM output that was cut off mid-syntax
 */
const TRUNCATION_PATTERNS = [
    /<[a-z][a-z0-9]*(?:\s+[^>]*)?$/i,   // Unclosed opening tag (no closing >)
    /<!--(?!.*-->).*$/s,                  // Unclosed comment (no -->)
    /<script[^>]*>(?![\s\S]*<\/script>)[\s\S]*$/i,  // Unclosed script
    /<style[^>]*>(?![\s\S]*<\/style>)[\s\S]*$/i,    // Unclosed style
    /=\s*["'][^"']*$/,                    // Unclosed attribute value (starts with = ")
];

/**
 * Detect if HTML is truncated (common LLM issue, especially with Llama 3.3)
 */
function detectHTMLTruncation(content) {
    const trimmed = content.trim();

    // Check for truncation patterns
    for (const pattern of TRUNCATION_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { truncated: true, reason: 'Unclosed syntax at end of content' };
        }
    }

    // Check if HTML ends abruptly (no closing html or body)
    const hasHtmlTag = /<html[^>]*>/i.test(trimmed);
    const hasClosingHtml = /<\/html\s*>/i.test(trimmed);
    const hasBodyTag = /<body[^>]*>/i.test(trimmed);
    const hasClosingBody = /<\/body\s*>/i.test(trimmed);

    if (hasHtmlTag && !hasClosingHtml) {
        return { truncated: true, reason: 'Missing closing </html> tag' };
    }

    if (hasBodyTag && !hasClosingBody) {
        return { truncated: true, reason: 'Missing closing </body> tag' };
    }

    // Check for unclosed script/style tags
    const scriptOpens = (trimmed.match(/<script[^>]*>/gi) || []).length;
    const scriptCloses = (trimmed.match(/<\/script>/gi) || []).length;
    if (scriptOpens > scriptCloses) {
        return { truncated: true, reason: 'Unclosed <script> tag' };
    }

    const styleOpens = (trimmed.match(/<style[^>]*>/gi) || []).length;
    const styleCloses = (trimmed.match(/<\/style>/gi) || []).length;
    if (styleOpens > styleCloses) {
        return { truncated: true, reason: 'Unclosed <style> tag' };
    }

    return { truncated: false };
}

/**
 * Check if HTML tags are properly balanced
 */
function checkTagBalance(content) {
    const result = { balanced: true, errors: [], unclosedTags: [] };
    const tagStack = [];
    const tagRegex = /<\/?([a-z][a-z0-9]*)[^>]*\/?>/gi;

    let match;
    let lineNumber = 1;
    let lastIndex = 0;

    while ((match = tagRegex.exec(content)) !== null) {
        // Count newlines to track line number
        const textBefore = content.substring(lastIndex, match.index);
        lineNumber += (textBefore.match(/\n/g) || []).length;
        lastIndex = match.index;

        const fullTag = match[0];
        const tagName = match[1].toLowerCase();

        // Skip void elements
        if (VOID_ELEMENTS.has(tagName)) continue;

        // Skip self-closing tags
        if (fullTag.endsWith('/>')) continue;

        // Skip comments, doctype, etc.
        if (fullTag.startsWith('<!') || fullTag.startsWith('<?')) continue;

        if (fullTag.startsWith('</')) {
            // Closing tag
            if (tagStack.length === 0) {
                result.balanced = false;
                result.errors.push({
                    message: `Unexpected closing tag </${tagName}>`,
                    line: lineNumber
                });
            } else {
                const lastOpen = tagStack.pop();
                if (lastOpen.name !== tagName) {
                    result.balanced = false;
                    result.errors.push({
                        message: `Mismatched tags: expected </${lastOpen.name}> but found </${tagName}>`,
                        line: lineNumber
                    });
                    // Try to recover by looking for matching tag
                    const matchingIndex = tagStack.findIndex(t => t.name === tagName);
                    if (matchingIndex >= 0) {
                        while (tagStack.length > matchingIndex) {
                            const unclosed = tagStack.pop();
                            result.errors.push({
                                message: `Unclosed tag <${unclosed.name}>`,
                                line: unclosed.line
                            });
                        }
                    }
                }
            }
        } else {
            // Opening tag
            tagStack.push({ name: tagName, line: lineNumber });
        }
    }

    // Check for unclosed tags
    while (tagStack.length > 0) {
        const unclosed = tagStack.pop();
        result.balanced = false;
        result.unclosedTags.push(unclosed.name);
        result.errors.push({
            message: `Unclosed tag <${unclosed.name}>`,
            line: unclosed.line
        });
    }

    return result;
}

/**
 * Find common HTML issues (accessibility, duplicates, etc.)
 */
function findHTMLIssues(content) {
    const issues = [];

    // Check for duplicate IDs
    const idMatches = content.match(/\bid\s*=\s*["']([^"']+)["']/gi) || [];
    const ids = {};
    for (const match of idMatches) {
        const idMatch = match.match(/["']([^"']+)["']/);
        if (idMatch) {
            const id = idMatch[1];
            if (ids[id]) {
                issues.push(`Duplicate ID: "${id}"`);
            }
            ids[id] = true;
        }
    }

    // Check for missing alt on images
    const imgTags = content.match(/<img[^>]*>/gi) || [];
    for (const img of imgTags) {
        if (!/\balt\s*=/i.test(img)) {
            issues.push('Image missing alt attribute');
        }
    }

    return issues;
}

/**
 * Comprehensive HTML validation
 */
function validateHTML(content) {
    const warnings = [];

    if (!content || typeof content !== 'string') {
        return { valid: false, error: 'Empty or invalid content', warnings };
    }

    const trimmed = content.trim();

    // Check for truncation first (most common LLM issue)
    const truncationCheck = detectHTMLTruncation(trimmed);
    if (truncationCheck.truncated) {
        return {
            valid: false,
            error: `HTML appears truncated: ${truncationCheck.reason}`,
            warnings,
            canRepair: true
        };
    }

    // Check for DOCTYPE
    if (!trimmed.includes('<!DOCTYPE') && !trimmed.includes('<!doctype')) {
        warnings.push('Missing DOCTYPE declaration');
    }

    // Check tag balance
    const tagBalance = checkTagBalance(trimmed);
    if (!tagBalance.balanced) {
        const errorMessages = tagBalance.errors.map(e => e.message).join('; ');
        return {
            valid: false,
            error: `Unbalanced HTML tags: ${errorMessages}`,
            warnings,
            canRepair: true,
            unclosedTags: tagBalance.unclosedTags
        };
    }

    // Check for common issues
    const issues = findHTMLIssues(trimmed);
    warnings.push(...issues);

    return { valid: true, warnings };
}

/**
 * Attempt to repair broken HTML
 */
export function repairHTML(content) {
    let repaired = content;
    const repairs = [];

    // Add DOCTYPE if missing
    if (!/<!DOCTYPE\s+html>/i.test(repaired)) {
        repaired = '<!DOCTYPE html>\n' + repaired;
        repairs.push('Added DOCTYPE declaration');
    }

    // Wrap in html tag if missing
    if (!/<html[^>]*>/i.test(repaired)) {
        const doctypeMatch = repaired.match(/<!DOCTYPE[^>]*>/i);
        if (doctypeMatch) {
            const afterDoctype = repaired.substring(doctypeMatch.index + doctypeMatch[0].length);
            repaired = doctypeMatch[0] + '\n<html lang="en">' + afterDoctype + '\n</html>';
        } else {
            repaired = '<html lang="en">\n' + repaired + '\n</html>';
        }
        repairs.push('Wrapped content in <html> tag');
    }

    // Add head if missing
    if (!/<head[^>]*>/i.test(repaired)) {
        const htmlMatch = repaired.match(/<html[^>]*>/i);
        if (htmlMatch) {
            const insertPos = htmlMatch.index + htmlMatch[0].length;
            const defaultHead = `
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Page</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>`;
            repaired = repaired.substring(0, insertPos) + defaultHead + repaired.substring(insertPos);
            repairs.push('Added default <head> section');
        }
    }

    // Add body if missing
    if (!/<body[^>]*>/i.test(repaired)) {
        const headCloseMatch = repaired.match(/<\/head\s*>/i);
        if (headCloseMatch) {
            const insertPos = headCloseMatch.index + headCloseMatch[0].length;
            const afterHead = repaired.substring(insertPos);
            const htmlCloseMatch = afterHead.match(/<\/html\s*>/i);
            if (htmlCloseMatch) {
                const bodyContent = afterHead.substring(0, htmlCloseMatch.index);
                const afterHtmlClose = afterHead.substring(htmlCloseMatch.index);
                repaired = repaired.substring(0, insertPos) + '\n<body>' + bodyContent + '</body>\n' + afterHtmlClose;
                repairs.push('Wrapped content in <body> tag');
            }
        }
    }

    // Close unclosed tags
    const balance = checkTagBalance(repaired);
    if (!balance.balanced && balance.unclosedTags.length > 0) {
        // Close unclosed tags at the end (before </body> or </html>)
        for (const tag of balance.unclosedTags.reverse()) {
            const bodyClose = repaired.lastIndexOf('</body>');
            const htmlClose = repaired.lastIndexOf('</html>');
            let insertPos = repaired.length;

            if (bodyClose > -1) {
                insertPos = bodyClose;
            } else if (htmlClose > -1) {
                insertPos = htmlClose;
            }

            repaired = repaired.substring(0, insertPos) + `</${tag}>` + repaired.substring(insertPos);
            repairs.push(`Added missing </${tag}> closing tag`);
        }
    }

    // Close unclosed script tags
    const scriptOpens = (repaired.match(/<script[^>]*>/gi) || []).length;
    const scriptCloses = (repaired.match(/<\/script>/gi) || []).length;
    if (scriptOpens > scriptCloses) {
        const diff = scriptOpens - scriptCloses;
        for (let i = 0; i < diff; i++) {
            repaired = repaired + '</script>';
            repairs.push('Added missing </script> closing tag');
        }
    }

    // Close unclosed style tags
    const styleOpens = (repaired.match(/<style[^>]*>/gi) || []).length;
    const styleCloses = (repaired.match(/<\/style>/gi) || []).length;
    if (styleOpens > styleCloses) {
        const diff = styleOpens - styleCloses;
        for (let i = 0; i < diff; i++) {
            repaired = repaired + '</style>';
            repairs.push('Added missing </style> closing tag');
        }
    }

    return {
        content: repaired,
        repairs,
        repaired: repairs.length > 0
    };
}

/**
 * Validate and optionally repair HTML
 */
export function validateAndRepairHTML(content, autoRepair = true) {
    const validation = validateHTML(content);

    if (validation.valid) {
        return {
            valid: true,
            content,
            repaired: false,
            warnings: validation.warnings
        };
    }

    if (!autoRepair || !validation.canRepair) {
        return {
            valid: false,
            content,
            repaired: false,
            error: validation.error,
            warnings: validation.warnings
        };
    }

    // Attempt repair
    const repair = repairHTML(content);

    // Re-validate repaired content
    const revalidation = validateHTML(repair.content);

    return {
        valid: revalidation.valid,
        content: repair.content,
        repaired: repair.repaired,
        repairs: repair.repairs,
        originalError: validation.error,
        error: revalidation.valid ? null : revalidation.error,
        warnings: revalidation.warnings
    };
}

function validateCSS(content) {
    const warnings = [];

    // Check for balanced braces
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;

    if (openBraces !== closeBraces) {
        return {
            valid: false,
            error: `Unbalanced braces: ${openBraces} opening vs ${closeBraces} closing`,
            warnings
        };
    }

    // Check for truncation
    const trimmed = content.trim();
    if (trimmed.endsWith('{') || trimmed.endsWith(':')) {
        return {
            valid: false,
            error: 'CSS appears truncated',
            warnings
        };
    }

    return { valid: true, warnings };
}

function validateJS(content) {
    const warnings = [];

    // Check for balanced braces, brackets, and parens
    const checks = [
        { open: '{', close: '}', name: 'braces' },
        { open: '[', close: ']', name: 'brackets' },
        { open: '(', close: ')', name: 'parentheses' }
    ];

    for (const check of checks) {
        // Simple count (doesn't account for strings/comments, but catches obvious issues)
        const openCount = (content.match(new RegExp('\\' + check.open, 'g')) || []).length;
        const closeCount = (content.match(new RegExp('\\' + check.close, 'g')) || []).length;

        if (openCount !== closeCount) {
            return {
                valid: false,
                error: `Unbalanced ${check.name}: ${openCount} opening vs ${closeCount} closing`,
                warnings
            };
        }
    }

    // Check for string issues (unclosed quotes) - simple check
    const singleQuotes = (content.match(/'/g) || []).length;
    const doubleQuotes = (content.match(/"/g) || []).length;
    const backticks = (content.match(/`/g) || []).length;

    if (singleQuotes % 2 !== 0) {
        warnings.push('Potentially unclosed single quote');
    }
    if (doubleQuotes % 2 !== 0) {
        warnings.push('Potentially unclosed double quote');
    }
    if (backticks % 2 !== 0) {
        warnings.push('Potentially unclosed template literal');
    }

    // Check for truncation
    const trimmed = content.trim();
    if (trimmed.endsWith('function') || trimmed.endsWith('const') ||
        trimmed.endsWith('let') || trimmed.endsWith('var') ||
        trimmed.endsWith('=') || trimmed.endsWith('{')) {
        return {
            valid: false,
            error: 'JavaScript appears truncated',
            warnings
        };
    }

    return { valid: true, warnings };
}

function validateJSON(content) {
    try {
        JSON.parse(content);
        return { valid: true, warnings: [] };
    } catch (e) {
        return {
            valid: false,
            error: `Invalid JSON: ${e.message}`,
            warnings: []
        };
    }
}

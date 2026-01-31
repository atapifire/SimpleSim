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
 * @returns {{valid: boolean, error?: string, warnings: string[]}}
 */
export function validateFileSyntax(path, content) {
    const warnings = [];
    const ext = path.split('.').pop()?.toLowerCase();

    if (!content || typeof content !== 'string') {
        return { valid: false, error: 'Empty or invalid content', warnings };
    }

    switch (ext) {
        case 'html':
        case 'htm':
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
 * @returns {{valid: boolean, issues: string[]}}
 */
export function validateGenerationResult(originalFiles, newFiles) {
    const issues = [];

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

    // Validate syntax for each new file
    for (const file of newFiles) {
        if (file.content) {
            const syntaxResult = validateFileSyntax(file.path, file.content);
            if (!syntaxResult.valid) {
                issues.push(`File "${file.path}" has syntax error: ${syntaxResult.error}`);
            }
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

function validateHTML(content) {
    const warnings = [];

    // Check for basic structure
    if (!content.includes('<!DOCTYPE') && !content.includes('<!doctype')) {
        warnings.push('Missing DOCTYPE declaration');
    }

    // Check for balanced tags (simple check)
    const openTags = (content.match(/<[a-zA-Z][^>]*[^/]>/g) || []).length;
    const closeTags = (content.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
    const selfClosing = (content.match(/<[a-zA-Z][^>]*\/>/g) || []).length;

    // This is a very rough check - HTML is complex
    if (Math.abs(openTags - closeTags - selfClosing) > 5) {
        warnings.push('Potentially unbalanced HTML tags');
    }

    // Check for truncated content (ends mid-tag)
    const trimmed = content.trim();
    if (trimmed.endsWith('<') || (trimmed.includes('<') && !trimmed.endsWith('>'))) {
        const lastOpen = trimmed.lastIndexOf('<');
        const lastClose = trimmed.lastIndexOf('>');
        if (lastOpen > lastClose) {
            return {
                valid: false,
                error: 'HTML appears truncated (ends with incomplete tag)',
                warnings
            };
        }
    }

    return { valid: true, warnings };
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

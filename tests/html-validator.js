/**
 * HTML Validator and Repair Module
 *
 * Validates and repairs LLM-generated HTML to prevent broken pages.
 * Optimized for handling output from various models including Llama 3.3.
 */

/**
 * Validation result structure
 */
export class ValidationResult {
    constructor() {
        this.valid = true;
        this.errors = [];
        this.warnings = [];
        this.repaired = false;
        this.repairedContent = null;
    }

    addError(message, line = null, suggestion = null) {
        this.valid = false;
        this.errors.push({ message, line, suggestion });
    }

    addWarning(message, line = null, suggestion = null) {
        this.warnings.push({ message, line, suggestion });
    }
}

/**
 * Self-closing tags that don't need closing tags
 */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Tags that should be present in valid HTML
 */
const REQUIRED_STRUCTURE = {
    doctype: /<!DOCTYPE\s+html>/i,
    html: /<html[^>]*>/i,
    head: /<head[^>]*>/i,
    body: /<body[^>]*>/i
};

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
 * Validate HTML content
 */
export function validateHtml(content, options = {}) {
    const result = new ValidationResult();
    const strict = options.strict || false;

    if (!content || typeof content !== 'string') {
        result.addError('Content is empty or not a string');
        return result;
    }

    const trimmed = content.trim();

    // Check for truncation
    const truncationCheck = detectTruncation(trimmed);
    if (truncationCheck.truncated) {
        result.addError(`HTML appears truncated: ${truncationCheck.reason}`, null, 'Content may have been cut off during generation');
    }

    // Check basic structure
    if (strict) {
        if (!REQUIRED_STRUCTURE.doctype.test(trimmed)) {
            result.addWarning('Missing DOCTYPE declaration', 1, 'Add <!DOCTYPE html> at the start');
        }
        if (!REQUIRED_STRUCTURE.html.test(trimmed)) {
            result.addError('Missing <html> tag');
        }
        if (!REQUIRED_STRUCTURE.head.test(trimmed)) {
            result.addWarning('Missing <head> tag');
        }
        if (!REQUIRED_STRUCTURE.body.test(trimmed)) {
            result.addWarning('Missing <body> tag');
        }
    }

    // Check for balanced tags
    const tagBalance = checkTagBalance(trimmed);
    if (!tagBalance.balanced) {
        for (const error of tagBalance.errors) {
            result.addError(error.message, error.line, error.suggestion);
        }
    }

    // Check for common issues
    const issues = findCommonIssues(trimmed);
    for (const issue of issues) {
        if (issue.severity === 'error') {
            result.addError(issue.message, issue.line, issue.suggestion);
        } else {
            result.addWarning(issue.message, issue.line, issue.suggestion);
        }
    }

    return result;
}

/**
 * Detect if HTML is truncated
 */
export function detectTruncation(content) {
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
 * Check if tags are properly balanced
 */
export function checkTagBalance(content) {
    const result = { balanced: true, errors: [] };
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
                    line: lineNumber,
                    suggestion: `Remove or add matching opening tag`
                });
            } else {
                const lastOpen = tagStack.pop();
                if (lastOpen.name !== tagName) {
                    result.balanced = false;
                    result.errors.push({
                        message: `Mismatched tags: expected </${lastOpen.name}> but found </${tagName}>`,
                        line: lineNumber,
                        suggestion: `Check tag order around line ${lastOpen.line}`
                    });
                    // Try to recover by looking for matching tag
                    const matchingIndex = tagStack.findIndex(t => t.name === tagName);
                    if (matchingIndex >= 0) {
                        // Pop until we find the matching tag
                        while (tagStack.length > matchingIndex) {
                            const unclosed = tagStack.pop();
                            result.errors.push({
                                message: `Unclosed tag <${unclosed.name}>`,
                                line: unclosed.line,
                                suggestion: `Add </${unclosed.name}> before </${tagName}>`
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
        result.errors.push({
            message: `Unclosed tag <${unclosed.name}>`,
            line: unclosed.line,
            suggestion: `Add </${unclosed.name}> closing tag`
        });
    }

    return result;
}

/**
 * Find common HTML issues
 */
export function findCommonIssues(content) {
    const issues = [];

    // Check for duplicate IDs
    const idMatches = content.match(/\bid\s*=\s*["']([^"']+)["']/gi) || [];
    const ids = {};
    for (const match of idMatches) {
        const id = match.match(/["']([^"']+)["']/)[1];
        if (ids[id]) {
            issues.push({
                severity: 'warning',
                message: `Duplicate ID: "${id}"`,
                suggestion: 'IDs must be unique within a document'
            });
        }
        ids[id] = true;
    }

    // Check for inline event handlers (potential XSS)
    const eventHandlers = content.match(/\bon[a-z]+\s*=\s*["'][^"']*["']/gi) || [];
    if (eventHandlers.length > 0) {
        issues.push({
            severity: 'warning',
            message: `Found ${eventHandlers.length} inline event handler(s)`,
            suggestion: 'Consider using addEventListener for better security'
        });
    }

    // Check for missing alt on images
    const imgTags = content.match(/<img[^>]*>/gi) || [];
    for (const img of imgTags) {
        if (!/\balt\s*=/i.test(img)) {
            issues.push({
                severity: 'warning',
                message: 'Image missing alt attribute',
                suggestion: 'Add alt="" for decorative images or descriptive text for content images'
            });
        }
    }

    // Check for empty links
    const emptyLinks = content.match(/<a[^>]*>\s*<\/a>/gi) || [];
    if (emptyLinks.length > 0) {
        issues.push({
            severity: 'warning',
            message: `Found ${emptyLinks.length} empty link(s)`,
            suggestion: 'Links should have visible content'
        });
    }

    // Check for potential script injection in attributes
    const dangerousPatterns = [
        /javascript\s*:/gi,
        /data\s*:/gi,
        /vbscript\s*:/gi
    ];
    for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
            issues.push({
                severity: 'warning',
                message: 'Potentially dangerous URI scheme found',
                suggestion: 'Avoid javascript:, data:, or vbscript: in URLs'
            });
            break;
        }
    }

    return issues;
}

/**
 * Attempt to repair broken HTML
 */
export function repairHtml(content, options = {}) {
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
            // Find content that should be in body
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

    // Close unclosed tags (simple approach)
    const balance = checkTagBalance(repaired);
    if (!balance.balanced) {
        // Find unclosed tags from both "Unclosed tag" and "Mismatched tags" errors
        const unclosedTags = [];

        for (const error of balance.errors) {
            // Direct "Unclosed tag <xyz>" error
            const unclosedMatch = error.message.match(/Unclosed tag <(\w+)>/);
            if (unclosedMatch) {
                unclosedTags.push(unclosedMatch[1]);
            }

            // "Mismatched tags: expected </xyz> but found </abc>" error
            // This means xyz was never closed before abc was closed
            const mismatchMatch = error.message.match(/expected <\/(\w+)> but found/);
            if (mismatchMatch) {
                unclosedTags.push(mismatchMatch[1]);
            }
        }

        // Remove duplicates and reverse (close in reverse order of opening)
        const uniqueTags = [...new Set(unclosedTags)].reverse();

        for (const tag of uniqueTags) {
            // Skip html/body - they're handled separately
            if (tag === 'html' || tag === 'body') continue;

            // Insert before </body> or </html> or at end
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
 * Validate and repair HTML, returning the best result
 */
export function validateAndRepair(content, options = {}) {
    const validation = validateHtml(content, options);

    if (validation.valid) {
        return {
            valid: true,
            content,
            repaired: false,
            errors: [],
            warnings: validation.warnings
        };
    }

    // Attempt repair
    const repair = repairHtml(content, options);

    // Re-validate repaired content
    const revalidation = validateHtml(repair.content, options);

    return {
        valid: revalidation.valid,
        content: repair.content,
        repaired: repair.repaired,
        repairs: repair.repairs,
        originalErrors: validation.errors,
        errors: revalidation.errors,
        warnings: revalidation.warnings
    };
}

export default {
    validateHtml,
    detectTruncation,
    checkTagBalance,
    findCommonIssues,
    repairHtml,
    validateAndRepair,
    ValidationResult
};

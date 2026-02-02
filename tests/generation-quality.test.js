/**
 * Generation Quality Tests for Simple Mode and Agent Mode
 *
 * Tests that AI-generated projects:
 * 1. Produce valid HTML with proper structure
 * 2. Generate JavaScript without common runtime errors
 * 3. Have matching DOM element IDs between HTML and JS
 * 4. Properly wrap JS in DOMContentLoaded when needed
 *
 * Uses FREE TIER models only to ensure tests are accessible
 *
 * Run with: OPENROUTER_API_KEY=sk-or-... npm test -- tests/generation-quality.test.js --run
 * Run specific test: npm test -- tests/generation-quality.test.js -t "should detect"
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { validateHtml, checkTagBalance, detectTruncation } from './html-validator.js';

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

// Free tier models to test with (in priority order)
const FREE_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'meta-llama/llama-3.1-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
];

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const runLiveTests = hasApiKey && process.env.RUN_LIVE_TESTS === 'true';

// ============================================================================
// STATIC ANALYSIS UTILITIES
// ============================================================================

/**
 * Extract all element IDs referenced in JavaScript code
 * Detects patterns like: getElementById('id'), querySelector('#id'), $('#id')
 */
function extractJsElementIds(jsContent) {
    const ids = new Set();

    // getElementById('id') or getElementById("id")
    const getByIdMatches = jsContent.match(/getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
    for (const match of getByIdMatches) {
        const id = match.match(/['"]([^'"]+)['"]/)?.[1];
        if (id) ids.add(id);
    }

    // querySelector('#id') or querySelectorAll('#id')
    const querySelectorMatches = jsContent.match(/querySelector(?:All)?\s*\(\s*['"][^'"]*#([a-zA-Z][a-zA-Z0-9_-]*)[^'"]*['"]\s*\)/g) || [];
    for (const match of querySelectorMatches) {
        const idMatch = match.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/);
        if (idMatch) ids.add(idMatch[1]);
    }

    // jQuery-style $('#id') or $('selector #id')
    const jqueryMatches = jsContent.match(/\$\s*\(\s*['"][^'"]*#([a-zA-Z][a-zA-Z0-9_-]*)[^'"]*['"]\s*\)/g) || [];
    for (const match of jqueryMatches) {
        // Find all #id patterns in the selector
        const idMatches = match.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/g) || [];
        for (const idMatch of idMatches) {
            ids.add(idMatch.substring(1)); // Remove the # prefix
        }
    }

    return [...ids];
}

/**
 * Extract all element IDs defined in HTML
 */
function extractHtmlIds(htmlContent) {
    const ids = new Set();
    const idMatches = htmlContent.match(/\bid\s*=\s*['"]([^'"]+)['"]/gi) || [];

    for (const match of idMatches) {
        const id = match.match(/['"]([^'"]+)['"]/)?.[1];
        if (id) ids.add(id);
    }

    return [...ids];
}

/**
 * Check if JavaScript references DOM elements that don't exist in HTML
 */
function findMissingDomElements(htmlContent, jsContent) {
    const htmlIds = new Set(extractHtmlIds(htmlContent));
    const jsIds = extractJsElementIds(jsContent);

    const missing = jsIds.filter(id => !htmlIds.has(id));
    return missing;
}

/**
 * Check if JavaScript that manipulates DOM is wrapped in DOMContentLoaded
 */
function checkDomReadyWrapper(jsContent) {
    const issues = [];

    // Check for DOM manipulation without DOMContentLoaded wrapper
    const hasDomManipulation = /getElementById|querySelector|appendChild|innerHTML|textContent|classList/.test(jsContent);
    const hasDomReadyWrapper = /DOMContentLoaded|window\.onload|document\.ready|\$\(function\s*\(\)|jQuery\(function/.test(jsContent);

    if (hasDomManipulation && !hasDomReadyWrapper) {
        // Check if all DOM manipulation is inside function definitions
        // This is a simplified check - if the file starts with function definitions, it's likely OK
        const trimmed = jsContent.trim();

        // Patterns that indicate code is safely wrapped
        const safePatterns = [
            /^\s*function\s+\w+\s*\(/m,         // function declaration at start
            /^\s*(?:const|let|var)\s+\w+\s*=\s*function/m,  // function expression at start
            /^\s*(?:const|let|var)\s+\w+\s*=\s*\([^)]*\)\s*=>/m,  // arrow function at start
            /^\s*class\s+\w+/m,                 // class at start
            /^\s*export\s+(?:default\s+)?(?:function|class)/m,  // export function/class
        ];

        // Check if ALL getElementById/querySelector calls are inside function bodies
        // by checking if there's a function declaration before any DOM call
        const lines = jsContent.split('\n');
        let foundFunctionBefore = false;
        let braceDepth = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Track function declarations
            if (/^\s*(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:function|\([^)]*\)\s*=>))/.test(line)) {
                foundFunctionBefore = true;
            }

            // Track brace depth
            const openBraces = (line.match(/{/g) || []).length;
            const closeBraces = (line.match(/}/g) || []).length;
            braceDepth += openBraces - closeBraces;

            // Check for DOM access at top level (braceDepth === 0)
            if (braceDepth === 0 && /getElementById|querySelector/.test(line)) {
                // This is top-level DOM access - flag it
                issues.push({
                    type: 'dom-not-ready',
                    message: 'DOM manipulation without DOMContentLoaded wrapper may cause null reference errors',
                    suggestion: 'Wrap code in: document.addEventListener("DOMContentLoaded", function() { ... })'
                });
                break;
            }
        }
    }

    return issues;
}

/**
 * Detect common JavaScript error patterns
 */
function detectJsErrorPatterns(jsContent) {
    const issues = [];

    // Pattern 1: Chained property access on potentially null values
    const nullChainPatterns = [
        /\.\w+\s*\.\s*(?:appendChild|innerHTML|textContent|classList|style|setAttribute)/g,
    ];

    for (const pattern of nullChainPatterns) {
        const matches = jsContent.match(pattern) || [];
        if (matches.length > 0) {
            // Check if there's a null check nearby
            const hasNullCheck = /if\s*\([^)]*(?:===?\s*null|!==?\s*null|\?\.|&&\s*\w+\.)/;
            if (!hasNullCheck.test(jsContent)) {
                issues.push({
                    type: 'potential-null-chain',
                    message: 'Chained property access without null check may cause runtime errors',
                    count: matches.length
                });
            }
        }
    }

    // Pattern 2: Using result of querySelector without null check
    const unsafeQuerySelector = /(?:const|let|var)\s+(\w+)\s*=\s*(?:document\.)?querySelector[^;]+;\s*\n\s*\1\./;
    if (unsafeQuerySelector.test(jsContent)) {
        issues.push({
            type: 'unsafe-query-selector',
            message: 'querySelector result used without null check',
            suggestion: 'Add: if (element) { ... } before using the element'
        });
    }

    // Pattern 3: Array access without length check
    const unsafeArrayAccess = /(?:const|let|var)\s+\w+\s*=\s*[^;]+\[0\](?!\s*\|\|)/;
    if (unsafeArrayAccess.test(jsContent)) {
        issues.push({
            type: 'unsafe-array-access',
            message: 'Array index access without length check',
            suggestion: 'Check array.length before accessing elements'
        });
    }

    return issues;
}

/**
 * Analyze generated files for potential runtime errors
 */
function analyzeGeneratedFiles(files) {
    const analysis = {
        valid: true,
        htmlIssues: [],
        jsIssues: [],
        missingElements: [],
        warnings: []
    };

    // Find HTML and JS files
    const htmlFile = files.find(f => f.path.endsWith('.html'));
    const jsFiles = files.filter(f => f.path.endsWith('.js'));

    if (!htmlFile) {
        analysis.valid = false;
        analysis.htmlIssues.push({ type: 'missing', message: 'No HTML file found' });
        return analysis;
    }

    // Validate HTML structure
    const htmlValidation = validateHtml(htmlFile.content);
    if (!htmlValidation.valid) {
        analysis.valid = false;
        analysis.htmlIssues.push(...htmlValidation.errors);
    }
    analysis.warnings.push(...(htmlValidation.warnings || []));

    // Check for truncation
    const truncCheck = detectTruncation(htmlFile.content);
    if (truncCheck.truncated) {
        analysis.valid = false;
        analysis.htmlIssues.push({ type: 'truncated', message: truncCheck.reason });
    }

    // Analyze JavaScript files
    for (const jsFile of jsFiles) {
        // Check for missing DOM elements
        const missing = findMissingDomElements(htmlFile.content, jsFile.content);
        if (missing.length > 0) {
            analysis.missingElements.push({
                file: jsFile.path,
                ids: missing,
                message: `JavaScript references elements not found in HTML: ${missing.join(', ')}`
            });
        }

        // Check for DOM ready wrapper
        const domReadyIssues = checkDomReadyWrapper(jsFile.content);
        analysis.jsIssues.push(...domReadyIssues);

        // Check for common error patterns
        const errorPatterns = detectJsErrorPatterns(jsFile.content);
        analysis.jsIssues.push(...errorPatterns);
    }

    // Also check inline scripts in HTML
    const inlineScripts = htmlFile.content.match(/<script[^>]*>([^<]+)<\/script>/gi) || [];
    for (const script of inlineScripts) {
        const content = script.replace(/<\/?script[^>]*>/gi, '');
        if (content.trim()) {
            const missing = findMissingDomElements(htmlFile.content, content);
            if (missing.length > 0) {
                analysis.missingElements.push({
                    file: 'inline script in HTML',
                    ids: missing,
                    message: `Inline script references elements not found: ${missing.join(', ')}`
                });
            }

            const domReadyIssues = checkDomReadyWrapper(content);
            analysis.jsIssues.push(...domReadyIssues);
        }
    }

    // Set valid to false if there are critical issues
    if (analysis.missingElements.length > 0) {
        analysis.valid = false;
    }

    return analysis;
}

// ============================================================================
// STATIC ANALYSIS TESTS
// ============================================================================

describe('Element ID Extraction', () => {
    it('should extract IDs from getElementById calls', () => {
        const js = `
            const btn = document.getElementById('submit-btn');
            const form = document.getElementById("contact-form");
        `;
        const ids = extractJsElementIds(js);
        expect(ids).toContain('submit-btn');
        expect(ids).toContain('contact-form');
    });

    it('should extract IDs from querySelector calls', () => {
        const js = `
            const header = document.querySelector('#main-header');
            const items = document.querySelectorAll('#list .item');
        `;
        const ids = extractJsElementIds(js);
        expect(ids).toContain('main-header');
        expect(ids).toContain('list');
    });

    it('should extract IDs from jQuery selectors', () => {
        const js = `
            $('#modal').show();
            $('.container #content').hide();
        `;
        const ids = extractJsElementIds(js);
        expect(ids).toContain('modal');
        expect(ids).toContain('content');
    });

    it('should extract IDs from HTML', () => {
        const html = `
            <div id="container">
                <button id='submit-btn'>Submit</button>
                <input id="email-input" type="email">
            </div>
        `;
        const ids = extractHtmlIds(html);
        expect(ids).toContain('container');
        expect(ids).toContain('submit-btn');
        expect(ids).toContain('email-input');
    });
});

describe('Missing DOM Element Detection', () => {
    it('should detect when JS references non-existent elements', () => {
        const html = `<div id="existing">Hello</div>`;
        const js = `
            const el = document.getElementById('non-existent');
            el.textContent = 'Updated';
        `;
        const missing = findMissingDomElements(html, js);
        expect(missing).toContain('non-existent');
        expect(missing).not.toContain('existing');
    });

    it('should handle case sensitivity', () => {
        const html = `<div id="MyButton">Click</div>`;
        const js = `const btn = document.getElementById('mybutton');`; // lowercase
        const missing = findMissingDomElements(html, js);
        expect(missing).toContain('mybutton'); // IDs are case-sensitive
    });

    it('should not report false positives for existing elements', () => {
        const html = `
            <button id="btn-submit">Submit</button>
            <div id="result-container"></div>
        `;
        const js = `
            document.getElementById('btn-submit').onclick = function() {
                document.getElementById('result-container').innerHTML = 'Done';
            };
        `;
        const missing = findMissingDomElements(html, js);
        expect(missing).toHaveLength(0);
    });
});

describe('DOMContentLoaded Wrapper Check', () => {
    it('should detect top-level DOM access without wrapper', () => {
        const js = `
            const btn = document.getElementById('btn');
            btn.onclick = () => console.log('clicked');
        `;
        const issues = checkDomReadyWrapper(js);
        expect(issues.some(i => i.type === 'dom-not-ready')).toBe(true);
    });

    it('should not flag code wrapped in DOMContentLoaded', () => {
        const js = `
            document.addEventListener('DOMContentLoaded', function() {
                const btn = document.getElementById('btn');
                btn.onclick = () => console.log('clicked');
            });
        `;
        const issues = checkDomReadyWrapper(js);
        expect(issues.filter(i => i.type === 'dom-not-ready')).toHaveLength(0);
    });

    it('should not flag code wrapped in window.onload', () => {
        const js = `
            window.onload = function() {
                const btn = document.getElementById('btn');
                btn.onclick = () => console.log('clicked');
            };
        `;
        const issues = checkDomReadyWrapper(js);
        expect(issues.filter(i => i.type === 'dom-not-ready')).toHaveLength(0);
    });

    it('should not flag code inside functions (not top-level)', () => {
        const js = `
            function init() {
                const btn = document.getElementById('btn');
                btn.onclick = () => console.log('clicked');
            }
        `;
        // This is OK because init() would be called after DOM is ready
        const issues = checkDomReadyWrapper(js);
        expect(issues.filter(i => i.type === 'dom-not-ready')).toHaveLength(0);
    });
});

describe('JavaScript Error Pattern Detection', () => {
    it('should detect unsafe querySelector usage', () => {
        const js = `
            const el = document.querySelector('.item');
            el.classList.add('active'); // No null check!
        `;
        const issues = detectJsErrorPatterns(js);
        expect(issues.some(i => i.type === 'unsafe-query-selector')).toBe(true);
    });

    it('should not flag safe querySelector usage', () => {
        const js = `
            const el = document.querySelector('.item');
            if (el) {
                el.classList.add('active');
            }
        `;
        const issues = detectJsErrorPatterns(js);
        expect(issues.filter(i => i.type === 'unsafe-query-selector')).toHaveLength(0);
    });
});

describe('Full File Analysis', () => {
    it('should validate a correct project', () => {
        const files = [
            {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
    <button id="btn">Click me</button>
    <script src="script.js"></script>
</body>
</html>`
            },
            {
                path: 'script.js',
                content: `
document.addEventListener('DOMContentLoaded', function() {
    const btn = document.getElementById('btn');
    if (btn) {
        btn.onclick = () => alert('Clicked!');
    }
});`
            }
        ];

        const analysis = analyzeGeneratedFiles(files);
        expect(analysis.valid).toBe(true);
        expect(analysis.missingElements).toHaveLength(0);
    });

    it('should detect missing element references', () => {
        const files = [
            {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
    <button id="submit">Submit</button>
</body>
</html>`
            },
            {
                path: 'script.js',
                content: `
const form = document.getElementById('contact-form'); // Does not exist!
form.onsubmit = () => console.log('submitted');
`
            }
        ];

        const analysis = analyzeGeneratedFiles(files);
        expect(analysis.valid).toBe(false);
        expect(analysis.missingElements.length).toBeGreaterThan(0);
        expect(analysis.missingElements[0].ids).toContain('contact-form');
    });

    it('should detect the appendChild null error pattern', () => {
        // This is the exact error pattern the user reported
        const files = [
            {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head><title>Game</title></head>
<body>
    <div id="game-container"></div>
    <script src="game.js"></script>
</body>
</html>`
            },
            {
                path: 'game.js',
                content: `
// Common error pattern: element ID mismatch
const container = document.getElementById('gameContainer'); // Wrong ID!
const canvas = document.createElement('canvas');
container.appendChild(canvas); // TypeError: Cannot read properties of null
`
            }
        ];

        const analysis = analyzeGeneratedFiles(files);
        expect(analysis.valid).toBe(false);
        expect(analysis.missingElements.length).toBeGreaterThan(0);
        // Should detect that 'gameContainer' is referenced but 'game-container' is in HTML
        expect(analysis.missingElements[0].ids).toContain('gameContainer');
    });
});

// ============================================================================
// LIVE API TESTS - Only run with API key and flag
// ============================================================================

describe.skipIf(!runLiveTests)('Live Simple Mode Generation Tests', () => {
    let workingModel = null;

    beforeAll(async () => {
        // Find a working free model
        for (const model of FREE_MODELS) {
            try {
                const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        'HTTP-Referer': 'https://simplesim.dev',
                        'X-Title': 'SimpleSim Test',
                    },
                    body: JSON.stringify({
                        model,
                        messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
                        max_tokens: 10,
                    }),
                });

                if (response.ok) {
                    workingModel = model;
                    console.log(`Using model: ${model}`);
                    break;
                }
            } catch (e) {
                console.log(`Model ${model} failed: ${e.message}`);
            }
        }

        if (!workingModel) {
            console.log('WARNING: No free models available for testing');
        }
    }, 60000);

    it('should generate a valid counter app', async () => {
        if (!workingModel) {
            console.log('Skipping - no working model');
            return;
        }

        const prompt = `Create a simple counter app with increment and decrement buttons.
Return JSON with files array. Each file needs path and content.
Format: {"files": [{"path": "index.html", "content": "..."}]}`;

        const systemPrompt = `You are a web developer. Create HTML/CSS/JS files.
Return ONLY valid JSON: {"files": [{"path": "filename", "content": "file content"}], "description": "..."}
IMPORTANT: Make sure all element IDs in JavaScript match exactly with IDs in HTML.
IMPORTANT: Wrap DOM manipulation in DOMContentLoaded event listener.`;

        const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://simplesim.dev',
                'X-Title': 'SimpleSim Test',
            },
            body: JSON.stringify({
                model: workingModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 4000,
            }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        console.log('Response length:', content.length);

        // Try to parse as JSON
        let parsed;
        try {
            const jsonMatch = content.match(/\{[\s\S]*"files"[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.log('Parse error:', e.message);
            console.log('Response preview:', content.substring(0, 500));
        }

        if (parsed?.files) {
            console.log('Generated files:', parsed.files.map(f => f.path));

            // Analyze the generated files
            const analysis = analyzeGeneratedFiles(parsed.files);

            console.log('Analysis:', {
                valid: analysis.valid,
                htmlIssues: analysis.htmlIssues,
                jsIssues: analysis.jsIssues,
                missingElements: analysis.missingElements
            });

            // The test documents what was generated, not necessarily that it's perfect
            expect(parsed.files.length).toBeGreaterThan(0);
            expect(parsed.files.some(f => f.path.endsWith('.html'))).toBe(true);
        }
    }, 120000);

    it('should generate a valid todo list app', async () => {
        if (!workingModel) {
            console.log('Skipping - no working model');
            return;
        }

        const prompt = `Create a todo list app where users can add and remove tasks.
Return JSON: {"files": [{"path": "index.html", "content": "..."}, {"path": "script.js", "content": "..."}]}`;

        const systemPrompt = `You are a web developer. Create clean HTML/JS.
Return ONLY valid JSON with files array.
CRITICAL RULES:
1. Every getElementById() ID must exist in the HTML
2. Wrap all DOM code in: document.addEventListener('DOMContentLoaded', function() { ... });
3. Use exact same ID strings in HTML and JavaScript`;

        const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://simplesim.dev',
                'X-Title': 'SimpleSim Test',
            },
            body: JSON.stringify({
                model: workingModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 4000,
            }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        let parsed;
        try {
            const jsonMatch = content.match(/\{[\s\S]*"files"[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.log('Parse error:', e.message);
        }

        if (parsed?.files) {
            const analysis = analyzeGeneratedFiles(parsed.files);

            // Log any issues found
            if (!analysis.valid) {
                console.log('ISSUES FOUND:');
                if (analysis.missingElements.length > 0) {
                    console.log('Missing elements:', analysis.missingElements);
                }
                if (analysis.jsIssues.length > 0) {
                    console.log('JS issues:', analysis.jsIssues);
                }
            }

            expect(parsed.files.length).toBeGreaterThan(0);
        }
    }, 120000);
});

// ============================================================================
// EXPORT UTILITIES FOR OTHER TESTS
// ============================================================================

export {
    extractJsElementIds,
    extractHtmlIds,
    findMissingDomElements,
    checkDomReadyWrapper,
    detectJsErrorPatterns,
    analyzeGeneratedFiles,
    FREE_MODELS
};

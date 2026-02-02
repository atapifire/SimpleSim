/**
 * Agent Mode Error Detection Tests
 *
 * Tests the Agent's ability to:
 * 1. Detect runtime errors via the preview_site and get_preview_errors tools
 * 2. Identify and fix common JavaScript errors
 * 3. Validate generated code before finishing
 *
 * Uses FREE TIER models for live tests
 *
 * Run with: OPENROUTER_API_KEY=sk-or-... RUN_LIVE_TESTS=true npm test -- tests/agent-error-detection.test.js --run
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    analyzeGeneratedFiles,
    findMissingDomElements,
    extractJsElementIds,
    extractHtmlIds
} from './generation-quality.test.js';

// ============================================================================
// MOCK SETUP - Simulates Agent Tool Execution
// ============================================================================

/**
 * Simulates the preview_site tool behavior
 * In real usage, this renders to an iframe and captures errors via postMessage
 */
function simulatePreviewSite(files) {
    const htmlFile = files.find(f => f.path.endsWith('.html'));
    const jsFiles = files.filter(f => f.path.endsWith('.js'));

    if (!htmlFile) {
        return { success: false, error: 'No HTML file to render' };
    }

    // Simulate error capture
    const errors = [];
    const consoleErrors = [];
    const warnings = [];

    // Check for missing DOM elements
    for (const jsFile of jsFiles) {
        const missing = findMissingDomElements(htmlFile.content, jsFile.content);
        for (const id of missing) {
            errors.push({
                type: 'runtime',
                message: `TypeError: Cannot read properties of null (reading 'appendChild')`,
                detail: `Element with ID '${id}' not found in DOM`,
                line: 'unknown'
            });
        }
    }

    // Check inline scripts too
    const inlineScripts = htmlFile.content.match(/<script[^>]*>([^<]+)<\/script>/gi) || [];
    for (const script of inlineScripts) {
        const content = script.replace(/<\/?script[^>]*>/gi, '');
        if (content.trim()) {
            const missing = findMissingDomElements(htmlFile.content, content);
            for (const id of missing) {
                errors.push({
                    type: 'runtime',
                    message: `TypeError: Cannot read properties of null`,
                    detail: `Inline script references '${id}' which doesn't exist`,
                    line: 'inline'
                });
            }
        }
    }

    return {
        success: true,
        message: 'Preview rendered',
        errorCount: errors.length,
        _capturedErrors: errors,  // For testing purposes
    };
}

/**
 * Simulates the get_preview_errors tool behavior
 */
function simulateGetPreviewErrors(previewResult) {
    if (!previewResult._capturedErrors) {
        return {
            success: true,
            hasErrors: false,
            message: 'No errors detected in the preview.',
        };
    }

    const errors = previewResult._capturedErrors;

    if (errors.length === 0) {
        return {
            success: true,
            hasErrors: false,
            message: 'No errors detected in the preview.',
        };
    }

    return {
        success: true,
        hasErrors: true,
        runtimeErrors: errors.map(e => ({
            type: e.type,
            message: e.message,
            detail: e.detail,
        })),
        hint: 'Fix the errors above. Common issues: null element references, undefined variables, missing DOM elements.'
    };
}

/**
 * Simulates the validate_file tool behavior
 */
function simulateValidateFile(file) {
    if (!file) {
        return { success: false, error: 'File not found' };
    }

    const issues = [];

    // Basic HTML validation
    if (file.path.endsWith('.html')) {
        if (!file.content.includes('<!DOCTYPE')) {
            issues.push('Missing DOCTYPE declaration');
        }
        if (!file.content.includes('<html')) {
            issues.push('Missing <html> tag');
        }
        if (!file.content.includes('<body')) {
            issues.push('Missing <body> tag');
        }
    }

    // Basic JS validation - check for syntax errors
    if (file.path.endsWith('.js')) {
        try {
            // Simple check - count braces
            const openBraces = (file.content.match(/{/g) || []).length;
            const closeBraces = (file.content.match(/}/g) || []).length;
            if (openBraces !== closeBraces) {
                issues.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close`);
            }

            const openParens = (file.content.match(/\(/g) || []).length;
            const closeParens = (file.content.match(/\)/g) || []).length;
            if (openParens !== closeParens) {
                issues.push(`Unbalanced parentheses: ${openParens} open, ${closeParens} close`);
            }
        } catch (e) {
            issues.push(`Syntax error: ${e.message}`);
        }
    }

    return {
        success: true,
        valid: issues.length === 0,
        issues,
    };
}

// ============================================================================
// TEST CASES
// ============================================================================

describe('Agent Tool Simulations', () => {
    describe('preview_site', () => {
        it('should detect missing DOM elements', () => {
            const files = [
                {
                    path: 'index.html',
                    content: `<!DOCTYPE html>
<html>
<body>
    <div id="container"></div>
    <script src="app.js"></script>
</body>
</html>`
                },
                {
                    path: 'app.js',
                    content: `
const el = document.getElementById('wrong-id');
el.appendChild(document.createElement('div'));
`
                }
            ];

            const result = simulatePreviewSite(files);
            expect(result.success).toBe(true);
            expect(result.errorCount).toBeGreaterThan(0);
        });

        it('should pass with correct DOM references', () => {
            const files = [
                {
                    path: 'index.html',
                    content: `<!DOCTYPE html>
<html>
<body>
    <div id="container"></div>
    <script src="app.js"></script>
</body>
</html>`
                },
                {
                    path: 'app.js',
                    content: `
const el = document.getElementById('container');
if (el) {
    el.appendChild(document.createElement('div'));
}
`
                }
            ];

            const result = simulatePreviewSite(files);
            expect(result.success).toBe(true);
            expect(result.errorCount).toBe(0);
        });
    });

    describe('get_preview_errors', () => {
        it('should format errors for agent consumption', () => {
            const previewResult = {
                success: true,
                _capturedErrors: [
                    {
                        type: 'runtime',
                        message: "Cannot read properties of null (reading 'appendChild')",
                        detail: "Element 'gameContainer' not found",
                    }
                ]
            };

            const errors = simulateGetPreviewErrors(previewResult);
            expect(errors.hasErrors).toBe(true);
            expect(errors.runtimeErrors).toHaveLength(1);
            expect(errors.runtimeErrors[0].message).toContain('appendChild');
            expect(errors.hint).toContain('null element');
        });

        it('should report no errors for clean preview', () => {
            const previewResult = {
                success: true,
                _capturedErrors: []
            };

            const errors = simulateGetPreviewErrors(previewResult);
            expect(errors.hasErrors).toBe(false);
        });
    });

    describe('validate_file', () => {
        it('should validate correct HTML', () => {
            const file = {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html lang="en">
<head><title>Test</title></head>
<body><h1>Hello</h1></body>
</html>`
            };

            const result = simulateValidateFile(file);
            expect(result.valid).toBe(true);
        });

        it('should detect missing DOCTYPE', () => {
            const file = {
                path: 'index.html',
                content: `<html><body><h1>Hello</h1></body></html>`
            };

            const result = simulateValidateFile(file);
            expect(result.valid).toBe(false);
            expect(result.issues.some(i => i.includes('DOCTYPE'))).toBe(true);
        });

        it('should detect unbalanced braces in JS', () => {
            const file = {
                path: 'app.js',
                content: `function test() {
    if (true) {
        console.log('missing close brace');
    }
// Note: missing closing brace for function`
            };

            const result = simulateValidateFile(file);
            expect(result.valid).toBe(false);
            expect(result.issues.some(i => i.includes('braces'))).toBe(true);
        });
    });
});

describe('Agent Error Detection Workflow', () => {
    /**
     * Simulates a full agent workflow:
     * 1. Generate files
     * 2. Preview and check for errors
     * 3. If errors, identify fixes
     */

    it('should detect and describe the appendChild null error', () => {
        // This simulates the exact error from the user's DragonTetris project
        const files = [
            {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dragon Tetris</title>
</head>
<body>
    <div id="game-container">
        <canvas id="gameCanvas"></canvas>
    </div>
    <script src="game.js"></script>
</body>
</html>`
            },
            {
                path: 'game.js',
                content: `
// Bug: ID mismatch - 'game' vs 'game-container'
const container = document.getElementById('game');
const scoreEl = document.createElement('div');
container.appendChild(scoreEl); // Line 100 - will throw error!

// Rest of game code...
function init() {
    console.log('Game initialized');
}
init();
`
            }
        ];

        // Step 1: Preview the site
        const previewResult = simulatePreviewSite(files);
        expect(previewResult.success).toBe(true);

        // Step 2: Get errors
        const errors = simulateGetPreviewErrors(previewResult);

        // Step 3: Verify error was detected
        expect(errors.hasErrors).toBe(true);
        expect(errors.runtimeErrors.length).toBeGreaterThan(0);

        // Step 4: Verify error message is useful for fixing
        const errorMessage = errors.runtimeErrors[0].message;
        expect(errorMessage).toContain('null');

        // The agent should be able to determine:
        // - Element 'game' is referenced in JS
        // - Element 'game' does NOT exist in HTML
        // - Element 'game-container' DOES exist in HTML
        // - Likely fix: change 'game' to 'game-container'

        const jsIds = extractJsElementIds(files[1].content);
        const htmlIds = extractHtmlIds(files[0].content);

        expect(jsIds).toContain('game');
        expect(htmlIds).not.toContain('game');
        expect(htmlIds).toContain('game-container');
    });

    it('should detect when fix resolves the error', () => {
        // Original buggy code
        const buggyFiles = [
            {
                path: 'index.html',
                content: `<html><body><div id="container"></div></body></html>`
            },
            {
                path: 'app.js',
                content: `const el = document.getElementById('cont');
el.textContent = 'Hello';`
            }
        ];

        const buggyPreview = simulatePreviewSite(buggyFiles);
        const buggyErrors = simulateGetPreviewErrors(buggyPreview);
        expect(buggyErrors.hasErrors).toBe(true);

        // Fixed code
        const fixedFiles = [
            {
                path: 'index.html',
                content: `<html><body><div id="container"></div></body></html>`
            },
            {
                path: 'app.js',
                content: `const el = document.getElementById('container');
if (el) el.textContent = 'Hello';`
            }
        ];

        const fixedPreview = simulatePreviewSite(fixedFiles);
        const fixedErrors = simulateGetPreviewErrors(fixedPreview);
        expect(fixedErrors.hasErrors).toBe(false);
    });
});

describe('Common Error Patterns', () => {
    const errorCases = [
        {
            name: 'ID typo (camelCase vs kebab-case)',
            html: `<div id="my-container"></div>`,
            js: `document.getElementById('myContainer')`,
            expectedMissing: ['myContainer'],
        },
        {
            name: 'ID typo (capitalization)',
            html: `<button id="Submit"></button>`,
            js: `document.getElementById('submit')`,
            expectedMissing: ['submit'],
        },
        {
            name: 'Element doesn\'t exist yet (created dynamically)',
            html: `<div id="app"></div>`,
            js: `document.getElementById('modal-overlay')`, // Created later
            expectedMissing: ['modal-overlay'],
        },
        {
            name: 'Nested selector with wrong parent',
            html: `<div id="wrapper"><span id="text"></span></div>`,
            js: `document.getElementById('container')`, // Wrong parent ID
            expectedMissing: ['container'],
        },
    ];

    for (const testCase of errorCases) {
        it(`should detect: ${testCase.name}`, () => {
            const missing = findMissingDomElements(testCase.html, testCase.js);
            expect(missing).toEqual(expect.arrayContaining(testCase.expectedMissing));
        });
    }
});

describe('Full Analysis Pipeline', () => {
    it('should provide comprehensive analysis of generated project', () => {
        const files = [
            {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Test App</title>
</head>
<body>
    <div id="app">
        <button id="btn-submit">Submit</button>
        <div id="output"></div>
    </div>
    <script src="main.js"></script>
</body>
</html>`
            },
            {
                path: 'main.js',
                content: `
document.addEventListener('DOMContentLoaded', function() {
    const btn = document.getElementById('btn-submit');
    const output = document.getElementById('output');

    btn.addEventListener('click', function() {
        output.textContent = 'Clicked!';
    });
});
`
            }
        ];

        const analysis = analyzeGeneratedFiles(files);

        expect(analysis.valid).toBe(true);
        expect(analysis.htmlIssues).toHaveLength(0);
        expect(analysis.missingElements).toHaveLength(0);
        expect(analysis.jsIssues).toHaveLength(0);
    });

    it('should catch multiple issues in complex project', () => {
        const files = [
            {
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head><title>Complex App</title></head>
<body>
    <div id="header"></div>
    <div id="content"></div>
    <div id="footer"></div>
</body>
</html>`
            },
            {
                path: 'app.js',
                content: `
// Multiple issues:
const header = document.getElementById('Header');  // Wrong case
const sidebar = document.getElementById('sidebar'); // Doesn't exist
const content = document.getElementById('content'); // OK

header.innerHTML = 'Welcome';
sidebar.style.display = 'block';
`
            }
        ];

        const analysis = analyzeGeneratedFiles(files);

        expect(analysis.valid).toBe(false);
        expect(analysis.missingElements.length).toBeGreaterThan(0);

        // Should detect both 'Header' (wrong case) and 'sidebar' (doesn't exist)
        const missingIds = analysis.missingElements.flatMap(m => m.ids);
        expect(missingIds).toContain('Header');
        expect(missingIds).toContain('sidebar');
    });
});

// ============================================================================
// LIVE API TESTS (Only run with API key)
// ============================================================================

const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const runLiveTests = hasApiKey && process.env.RUN_LIVE_TESTS === 'true';

describe.skipIf(!runLiveTests)('Live Agent Error Correction', () => {
    const FREE_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
    const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

    it('should generate fix for missing element error', async () => {
        const errorContext = `
The following JavaScript error occurred in the preview:
TypeError: Cannot read properties of null (reading 'appendChild')
at line 5 in game.js

The code is:
const container = document.getElementById('game');
container.appendChild(canvas);

The HTML contains:
<div id="game-container">...</div>

What is the fix?
`;

        const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://simplesim.dev',
                'X-Title': 'SimpleSim Test',
            },
            body: JSON.stringify({
                model: FREE_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a JavaScript debugging expert. Identify the bug and provide the fix.'
                    },
                    { role: 'user', content: errorContext }
                ],
                max_tokens: 500,
            }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        console.log('Model response:', content.substring(0, 500));

        // Check if the model identified the fix
        expect(content.toLowerCase()).toMatch(/game-container|id.*mismatch|wrong.*id|change.*game.*to/i);
    }, 60000);
});

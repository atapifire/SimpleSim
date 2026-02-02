/**
 * Llama 3.3 70B Diagnostic Tests
 *
 * Comprehensive tests to diagnose why llama-3.3-70b-instruct:free
 * struggles to generate working websites.
 *
 * Features:
 * - Visual screenshots via Puppeteer
 * - JavaScript error capture
 * - Multi-iteration agent-style generation
 * - Detailed failure diagnostics
 *
 * Run with:
 *   OPENROUTER_API_KEY=sk-or-... npm test -- tests/llama-diagnostic.test.js --run
 *
 * Or for full diagnostic output:
 *   OPENROUTER_API_KEY=sk-or-... RUN_LIVE_TESTS=true npm test -- tests/llama-diagnostic.test.js --run
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// Test configuration
const MODEL_ID = 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ITERATIONS = 3;  // 3 agent calls, ~10 iterations each
const API_TIMEOUT = 120000; // 2 minutes per call

// Output directory for screenshots and logs
const OUTPUT_DIR = path.join(process.cwd(), 'test-output', 'llama-diagnostic');

// Check if we should run live tests
const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const runLiveTests = hasApiKey;

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Call the OpenRouter API with the given messages
 */
async function callLlamaAPI(messages, tools = null) {
    const requestBody = {
        model: MODEL_ID,
        messages,
        max_tokens: 8192,
        temperature: 0.7,
    };

    if (tools) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`API CALL to ${MODEL_ID}`);
    console.log(`Messages: ${messages.length}, Last role: ${messages[messages.length - 1]?.role}`);
    console.log(`${'='.repeat(60)}`);

    const startTime = Date.now();

    const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://simplesim.dev',
            'X-Title': 'SimpleSim Diagnostic Test',
        },
        body: JSON.stringify(requestBody),
    });

    const elapsed = Date.now() - startTime;
    const data = await response.json();

    console.log(`Response status: ${response.status} (${elapsed}ms)`);

    if (!response.ok) {
        console.log('API ERROR:', JSON.stringify(data, null, 2));
        throw new Error(`API Error: ${data.error?.message || response.statusText}`);
    }

    const content = data.choices?.[0]?.message?.content || '';
    const toolCalls = data.choices?.[0]?.message?.tool_calls || [];

    console.log(`Content length: ${content.length} chars`);
    console.log(`Tool calls: ${toolCalls.length}`);

    if (content) {
        // Log first/last 200 chars to see structure
        console.log(`Content preview: ${content.substring(0, 200)}...`);
        console.log(`Content end: ...${content.substring(content.length - 200)}`);
    }

    return {
        content,
        toolCalls,
        raw: data,
        elapsed
    };
}

/**
 * Parse JSON response from model, handling various formats
 */
function parseModelResponse(content) {
    const diagnostics = {
        rawLength: content.length,
        hasJsonBlock: false,
        hasHtmlDirect: false,
        parseAttempts: [],
        files: null,
        error: null
    };

    // Strategy 1: Look for JSON code block
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
        diagnostics.hasJsonBlock = true;
        try {
            const parsed = JSON.parse(jsonBlockMatch[1].trim());
            diagnostics.parseAttempts.push({ strategy: 'json-block', success: true });
            diagnostics.files = parsed.files || [parsed];
            return diagnostics;
        } catch (e) {
            diagnostics.parseAttempts.push({ strategy: 'json-block', success: false, error: e.message });
        }
    }

    // Strategy 2: Look for raw JSON object
    const jsonMatch = content.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            diagnostics.parseAttempts.push({ strategy: 'raw-json', success: true });
            diagnostics.files = parsed.files || [parsed];
            return diagnostics;
        } catch (e) {
            diagnostics.parseAttempts.push({ strategy: 'raw-json', success: false, error: e.message });
        }
    }

    // Strategy 3: Look for HTML directly in response
    const htmlMatch = content.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
    if (htmlMatch) {
        diagnostics.hasHtmlDirect = true;
        diagnostics.parseAttempts.push({ strategy: 'direct-html', success: true });
        diagnostics.files = [{ path: 'index.html', content: htmlMatch[0] }];
        return diagnostics;
    }

    // Strategy 4: Look for individual file blocks
    const fileBlocks = [];
    const htmlBlock = content.match(/```html\s*([\s\S]*?)```/);
    const cssBlock = content.match(/```css\s*([\s\S]*?)```/);
    const jsBlock = content.match(/```(?:javascript|js)\s*([\s\S]*?)```/);

    if (htmlBlock) fileBlocks.push({ path: 'index.html', content: htmlBlock[1].trim() });
    if (cssBlock) fileBlocks.push({ path: 'style.css', content: cssBlock[1].trim() });
    if (jsBlock) fileBlocks.push({ path: 'script.js', content: jsBlock[1].trim() });

    if (fileBlocks.length > 0) {
        diagnostics.parseAttempts.push({ strategy: 'code-blocks', success: true, fileCount: fileBlocks.length });
        diagnostics.files = fileBlocks;
        return diagnostics;
    }

    diagnostics.parseAttempts.push({ strategy: 'all-failed', success: false });
    diagnostics.error = 'Could not parse any files from response';
    return diagnostics;
}

/**
 * Render HTML in Puppeteer and capture screenshot + errors
 */
async function renderAndCapture(browser, html, testName, iteration) {
    const page = await browser.newPage();
    const errors = [];
    const consoleMessages = [];

    // Capture JavaScript errors
    page.on('pageerror', error => {
        errors.push({
            type: 'error',
            message: error.message,
            stack: error.stack
        });
    });

    // Capture console messages
    page.on('console', msg => {
        consoleMessages.push({
            type: msg.type(),
            text: msg.text()
        });
        if (msg.type() === 'error') {
            errors.push({
                type: 'console-error',
                message: msg.text()
            });
        }
    });

    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });

    // Load the HTML
    try {
        await page.setContent(html, {
            waitUntil: 'networkidle0',
            timeout: 10000
        });
    } catch (e) {
        errors.push({
            type: 'load-error',
            message: e.message
        });
    }

    // Wait a bit for any animations/scripts
    await new Promise(r => setTimeout(r, 1000));

    // Take screenshot
    const screenshotPath = path.join(OUTPUT_DIR, `${testName}-iter${iteration}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Get page title and content info
    const pageInfo = await page.evaluate(() => {
        return {
            title: document.title,
            bodyText: document.body?.innerText?.substring(0, 500) || '',
            elementCount: document.querySelectorAll('*').length,
            hasCanvas: !!document.querySelector('canvas'),
            canvasCount: document.querySelectorAll('canvas').length,
            scriptCount: document.querySelectorAll('script').length,
        };
    });

    await page.close();

    return {
        screenshotPath,
        errors,
        consoleMessages,
        pageInfo
    };
}

/**
 * Build a complete HTML document from files
 * Always inlines CSS and JS for local rendering
 */
function buildHtmlDocument(files) {
    const htmlFile = files.find(f => f.path === 'index.html' || f.path.endsWith('.html'));
    const cssFile = files.find(f => f.path === 'style.css' || f.path === 'styles.css' || f.path.endsWith('.css'));
    const jsFile = files.find(f => f.path === 'script.js' || f.path === 'main.js' || f.path === 'app.js' || f.path.endsWith('.js'));

    if (!htmlFile) {
        return null;
    }

    let html = htmlFile.content;

    // Remove external CSS references (we'll inline instead)
    html = html.replace(/<link[^>]*rel=['"]stylesheet['"][^>]*>/gi, '');
    html = html.replace(/<link[^>]*href=['"][^'"]*\.css['"][^>]*>/gi, '');

    // Remove external JS references (we'll inline instead)
    html = html.replace(/<script[^>]*src=['"][^'"]*\.js['"][^>]*>\s*<\/script>/gi, '');

    // Inject CSS
    if (cssFile) {
        const cssTag = `<style>\n${cssFile.content}\n</style>`;
        if (html.includes('</head>')) {
            html = html.replace('</head>', `${cssTag}\n</head>`);
        } else if (html.includes('<body')) {
            html = html.replace('<body', `${cssTag}\n<body`);
        } else {
            html = cssTag + html;
        }
    }

    // Inject JS (ALWAYS inline for local rendering)
    if (jsFile) {
        // Check if JS uses ES modules
        const isModule = /^\s*(import|export)\s/m.test(jsFile.content);
        const scriptType = isModule ? ' type="module"' : '';
        const jsTag = `<script${scriptType}>\n${jsFile.content}\n</script>`;
        if (html.includes('</body>')) {
            html = html.replace('</body>', `${jsTag}\n</body>`);
        } else if (html.includes('</html>')) {
            html = html.replace('</html>', `${jsTag}\n</html>`);
        } else {
            html = html + jsTag;
        }
    }

    return html;
}

/**
 * Analyze generated code for common issues
 */
function analyzeCode(files) {
    const issues = [];
    const warnings = [];

    for (const file of files) {
        const content = file.content || '';

        // Check for truncation
        if (content.includes('...') && content.length < 500) {
            issues.push(`${file.path}: Appears truncated (contains "..." and is short)`);
        }

        // Check for incomplete code
        if (file.path.endsWith('.js')) {
            const openBraces = (content.match(/\{/g) || []).length;
            const closeBraces = (content.match(/\}/g) || []).length;
            if (openBraces !== closeBraces) {
                issues.push(`${file.path}: Mismatched braces (${openBraces} open, ${closeBraces} close)`);
            }

            // Check for undefined references
            if (content.includes('undefined') && !content.includes('typeof')) {
                warnings.push(`${file.path}: Contains 'undefined' - may indicate missing definitions`);
            }

            // Check for ES module issues
            if (/^\s*import\s/m.test(content) && !content.includes('type="module"')) {
                warnings.push(`${file.path}: Uses ES imports but may be missing type="module"`);
            }
        }

        if (file.path.endsWith('.html')) {
            // Check for basic structure
            if (!content.includes('<!DOCTYPE') && !content.includes('<!doctype')) {
                warnings.push(`${file.path}: Missing DOCTYPE declaration`);
            }
            if (!content.includes('<html')) {
                issues.push(`${file.path}: Missing <html> tag`);
            }
            if (!content.includes('</html>')) {
                issues.push(`${file.path}: Missing closing </html> tag - likely truncated`);
            }
        }
    }

    return { issues, warnings };
}

/**
 * Create the system prompt for Simple Mode generation
 */
function getSystemPrompt() {
    return `You are an expert Frontend Developer. Create a complete, working website.

CRITICAL REQUIREMENTS:
1. Return ONLY valid JSON in this exact format:
{
  "files": [
    {"path": "index.html", "content": "...complete HTML..."},
    {"path": "style.css", "content": "...complete CSS..."},
    {"path": "script.js", "content": "...complete JavaScript..."}
  ],
  "description": "Brief description"
}

2. The code must be COMPLETE - no placeholders, no "..." truncation
3. All JavaScript must be fully functional
4. Use modern ES6+ JavaScript
5. For games: use requestAnimationFrame for animation loops
6. For canvas games: properly initialize and use 2D context

DO NOT include any text outside the JSON. Start with { and end with }`;
}

// =============================================================================
// DIAGNOSTIC TEST SUITE
// =============================================================================

describe('Llama 3.3 70B Diagnostic Tests', () => {
    let browser;

    beforeAll(async () => {
        if (runLiveTests) {
            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            console.log('\nPuppeteer browser launched for visual testing');
        }
    });

    afterAll(async () => {
        if (browser) {
            await browser.close();
        }
    });

    describe.skipIf(!runLiveTests)('Tetris Game Generation', () => {
        const allResults = [];

        it('should generate a working Tetris game', async () => {
            console.log('\n' + '='.repeat(70));
            console.log('TETRIS GAME GENERATION TEST');
            console.log('='.repeat(70));

            const prompt = `Create a Tetris game with:
- A 10x20 game board with colored falling pieces
- All 7 standard Tetris pieces (I, O, T, S, Z, J, L)
- Arrow keys to move/rotate pieces
- Piece collision detection
- Line clearing when rows are full
- Score display
- Game over detection

Make it visually appealing with a dark theme and colorful pieces.`;

            let files = null;
            let lastError = null;

            for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
                console.log(`\n${'─'.repeat(50)}`);
                console.log(`ITERATION ${iteration}/${MAX_ITERATIONS}`);
                console.log(`${'─'.repeat(50)}`);

                const messages = [
                    { role: 'system', content: getSystemPrompt() },
                    { role: 'user', content: prompt }
                ];

                // If we had errors from last iteration, add them as context
                if (lastError && iteration > 1) {
                    messages.push({
                        role: 'assistant',
                        content: '```json\n' + JSON.stringify({ files: files }, null, 2) + '\n```'
                    });
                    messages.push({
                        role: 'user',
                        content: `The previous code had errors:\n${lastError}\n\nPlease fix these issues and return the complete, corrected code.`
                    });
                }

                try {
                    const response = await callLlamaAPI(messages);

                    // Save raw response for analysis
                    const responseFile = path.join(OUTPUT_DIR, `tetris-iter${iteration}-response.txt`);
                    fs.writeFileSync(responseFile, response.content);
                    console.log(`Raw response saved to: ${responseFile}`);

                    // Parse the response
                    const parseResult = parseModelResponse(response.content);
                    console.log('\nParse diagnostics:', JSON.stringify(parseResult.parseAttempts, null, 2));

                    if (!parseResult.files) {
                        lastError = `Failed to parse response: ${parseResult.error}`;
                        console.log('PARSE ERROR:', lastError);
                        continue;
                    }

                    files = parseResult.files;
                    console.log(`\nParsed ${files.length} files:`, files.map(f => `${f.path} (${f.content?.length || 0} chars)`));

                    // Analyze the code
                    const analysis = analyzeCode(files);
                    if (analysis.issues.length > 0) {
                        console.log('\nCode issues found:', analysis.issues);
                    }
                    if (analysis.warnings.length > 0) {
                        console.log('Warnings:', analysis.warnings);
                    }

                    // Build complete HTML
                    const html = buildHtmlDocument(files);
                    if (!html) {
                        lastError = 'Could not build HTML document - missing index.html';
                        console.log('BUILD ERROR:', lastError);
                        continue;
                    }

                    // Save the HTML
                    const htmlFile = path.join(OUTPUT_DIR, `tetris-iter${iteration}.html`);
                    fs.writeFileSync(htmlFile, html);
                    console.log(`HTML saved to: ${htmlFile}`);

                    // Render and capture
                    const renderResult = await renderAndCapture(browser, html, 'tetris', iteration);
                    console.log(`\nScreenshot: ${renderResult.screenshotPath}`);
                    console.log('Page info:', renderResult.pageInfo);

                    if (renderResult.errors.length > 0) {
                        console.log('\nJavaScript ERRORS:');
                        renderResult.errors.forEach(e => {
                            console.log(`  - [${e.type}] ${e.message}`);
                        });
                        lastError = renderResult.errors.map(e => e.message).join('\n');
                    } else {
                        console.log('\nNo JavaScript errors detected!');
                        lastError = null;
                    }

                    // Store results
                    allResults.push({
                        iteration,
                        files: files.map(f => ({ path: f.path, length: f.content?.length || 0 })),
                        parseResult: parseResult.parseAttempts,
                        codeAnalysis: analysis,
                        renderResult: {
                            errorCount: renderResult.errors.length,
                            errors: renderResult.errors,
                            pageInfo: renderResult.pageInfo
                        }
                    });

                    // If no errors and we have a canvas, consider it a success
                    if (renderResult.errors.length === 0 && renderResult.pageInfo.hasCanvas) {
                        console.log('\n✓ SUCCESS: Generated working Tetris game!');
                        break;
                    }

                } catch (error) {
                    console.log('API ERROR:', error.message);
                    lastError = error.message;
                }

                // Wait between iterations to avoid rate limits
                if (iteration < MAX_ITERATIONS) {
                    console.log('\nWaiting 5s before next iteration...');
                    await new Promise(r => setTimeout(r, 5000));
                }
            }

            // Save full diagnostic report
            const report = {
                model: MODEL_ID,
                prompt: prompt.substring(0, 200) + '...',
                totalIterations: allResults.length,
                results: allResults,
                finalSuccess: allResults.some(r => r.renderResult.errorCount === 0 && r.renderResult.pageInfo?.hasCanvas)
            };

            const reportFile = path.join(OUTPUT_DIR, 'tetris-diagnostic-report.json');
            fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
            console.log(`\nFull diagnostic report: ${reportFile}`);

            // Print summary
            console.log('\n' + '='.repeat(70));
            console.log('DIAGNOSTIC SUMMARY');
            console.log('='.repeat(70));
            console.log(`Model: ${MODEL_ID}`);
            console.log(`Iterations run: ${allResults.length}`);

            for (const result of allResults) {
                console.log(`\nIteration ${result.iteration}:`);
                console.log(`  - Files: ${result.files.map(f => `${f.path}(${f.length})`).join(', ')}`);
                console.log(`  - Parse: ${result.parseResult.map(p => `${p.strategy}:${p.success}`).join(', ')}`);
                console.log(`  - Issues: ${result.codeAnalysis.issues.length} issues, ${result.codeAnalysis.warnings.length} warnings`);
                console.log(`  - Runtime: ${result.renderResult.errorCount} errors`);
                if (result.renderResult.errors.length > 0) {
                    console.log(`  - Error details: ${result.renderResult.errors[0]?.message?.substring(0, 100)}`);
                }
            }

            // The test passes if we can at least generate SOME code
            expect(allResults.length).toBeGreaterThan(0);
            expect(files).not.toBeNull();

        }, 600000); // 10 minute timeout for all iterations
    });

    describe.skipIf(!runLiveTests)('Simple Counter App Generation', () => {
        it('should generate a working counter app', async () => {
            console.log('\n' + '='.repeat(70));
            console.log('COUNTER APP GENERATION TEST');
            console.log('='.repeat(70));

            const prompt = `Create a simple counter app with:
- A large number display showing the current count (starts at 0)
- A "+" button to increment
- A "-" button to decrement
- A "Reset" button to set count back to 0
- Nice styling with centered content`;

            const messages = [
                { role: 'system', content: getSystemPrompt() },
                { role: 'user', content: prompt }
            ];

            const response = await callLlamaAPI(messages);

            // Save raw response
            const responseFile = path.join(OUTPUT_DIR, 'counter-response.txt');
            fs.writeFileSync(responseFile, response.content);

            const parseResult = parseModelResponse(response.content);
            console.log('Parse result:', parseResult.parseAttempts);

            expect(parseResult.files).not.toBeNull();

            if (parseResult.files) {
                const html = buildHtmlDocument(parseResult.files);

                if (html) {
                    fs.writeFileSync(path.join(OUTPUT_DIR, 'counter.html'), html);

                    const renderResult = await renderAndCapture(browser, html, 'counter', 1);
                    console.log('Page info:', renderResult.pageInfo);
                    console.log('Errors:', renderResult.errors.length);

                    if (renderResult.errors.length > 0) {
                        console.log('Error details:', renderResult.errors);
                    }

                    // Should have minimal or no errors for a simple counter
                    expect(renderResult.errors.length).toBeLessThan(3);
                }
            }

        }, 120000);
    });

    describe.skipIf(!runLiveTests)('Response Format Analysis', () => {
        it('should analyze how llama formats JSON responses', async () => {
            console.log('\n' + '='.repeat(70));
            console.log('JSON FORMAT ANALYSIS TEST');
            console.log('='.repeat(70));

            const prompt = `Create a single HTML page that displays "Hello World" in a large heading.`;

            const messages = [
                { role: 'system', content: getSystemPrompt() },
                { role: 'user', content: prompt }
            ];

            const response = await callLlamaAPI(messages);

            // Detailed analysis of response format
            const analysis = {
                totalLength: response.content.length,
                startsWithBrace: response.content.trim().startsWith('{'),
                endsWithBrace: response.content.trim().endsWith('}'),
                hasCodeBlock: response.content.includes('```'),
                hasJsonKeyword: response.content.toLowerCase().includes('json'),
                firstChars: response.content.substring(0, 100),
                lastChars: response.content.substring(response.content.length - 100),
                newlineCount: (response.content.match(/\n/g) || []).length,
            };

            console.log('\nResponse format analysis:');
            console.log(JSON.stringify(analysis, null, 2));

            // Save for inspection
            fs.writeFileSync(
                path.join(OUTPUT_DIR, 'format-analysis.json'),
                JSON.stringify({ analysis, rawResponse: response.content }, null, 2)
            );

            // Try to parse
            const parseResult = parseModelResponse(response.content);
            console.log('\nParse attempts:', parseResult.parseAttempts);

            expect(response.content.length).toBeGreaterThan(50);

        }, 60000);
    });
});

// =============================================================================
// AGENT MODE SIMULATION
// =============================================================================

describe.skipIf(!runLiveTests)('Llama Agent Mode Simulation', () => {
    let browser;

    beforeAll(async () => {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    });

    afterAll(async () => {
        if (browser) await browser.close();
    });

    it('should generate a 3D scene using agent-style tool calls', async () => {
        console.log('\n' + '='.repeat(70));
        console.log('AGENT MODE SIMULATION - 3D SCENE');
        console.log('='.repeat(70));

        const tools = [
            {
                type: 'function',
                function: {
                    name: 'write_file',
                    description: 'Create or overwrite a file with new content',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path (e.g., index.html)' },
                            content: { type: 'string', description: 'Complete file content' }
                        },
                        required: ['path', 'content']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'check_dom',
                    description: 'Check for DOM element mismatches between HTML and JS',
                    parameters: { type: 'object', properties: {}, required: [] }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'finish',
                    description: 'Signal completion. Call only after checking for errors.',
                    parameters: {
                        type: 'object',
                        properties: {
                            summary: { type: 'string', description: 'Summary of changes' }
                        },
                        required: ['summary']
                    }
                }
            }
        ];

        const systemPrompt = `You are an expert Frontend Developer. Create websites using the provided tools.

WORKFLOW:
1. Use write_file to create index.html with complete HTML
2. Use write_file to create style.css with CSS
3. Use write_file to create script.js with JavaScript
4. Call check_dom to verify element IDs match
5. Call finish with a summary

For 3D graphics, use Three.js from CDN:
<script type="importmap">{"imports":{"three":"https://esm.sh/three@0.160.0"}}</script>
<script type="module">import * as THREE from 'three';</script>

CRITICAL: Create COMPLETE, working code. No placeholders.`;

        const userPrompt = `Create a simple 3D scene with:
- A rotating colored cube
- Dark background
- The cube should spin continuously`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const files = new Map();
        let finished = false;
        let iterations = 0;
        const maxIterations = 10;

        while (!finished && iterations < maxIterations) {
            iterations++;
            console.log(`\n--- Agent Iteration ${iterations} ---`);

            try {
                const response = await callLlamaAPI(messages, tools);

                if (response.toolCalls && response.toolCalls.length > 0) {
                    // Add assistant message with tool calls
                    messages.push({
                        role: 'assistant',
                        content: response.content || null,
                        tool_calls: response.toolCalls
                    });

                    // Process each tool call
                    for (const toolCall of response.toolCalls) {
                        const name = toolCall.function.name;
                        const rawArgs = toolCall.function.arguments;
                        let args = {};

                        // Log raw arguments for debugging
                        console.log(`\nTool call: ${name}`);
                        console.log(`Raw arguments type: ${typeof rawArgs}`);
                        console.log(`Raw arguments: ${JSON.stringify(rawArgs)?.substring(0, 500)}`);

                        try {
                            if (typeof rawArgs === 'string') {
                                args = JSON.parse(rawArgs);
                            } else if (typeof rawArgs === 'object') {
                                args = rawArgs;
                            }
                        } catch (e) {
                            console.log('JSON parse error:', e.message);
                        }

                        console.log(`Parsed args:`, name === 'write_file'
                            ? `path=${args.path}, content=${args.content?.length || 0} chars`
                            : JSON.stringify(args));

                        let result = { success: true };

                        if (name === 'write_file') {
                            files.set(args.path, args.content);
                            result.message = `Wrote ${args.path}`;
                        } else if (name === 'check_dom') {
                            result.valid = true;
                            result.message = 'DOM check passed';
                        } else if (name === 'finish') {
                            finished = true;
                            result.message = 'Finished';
                        }

                        // Add tool result
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(result)
                        });
                    }
                } else if (response.content) {
                    console.log('Model responded with text instead of tools');
                    console.log('Content:', response.content.substring(0, 500));

                    // Try to prompt for tool use
                    messages.push({
                        role: 'assistant',
                        content: response.content
                    });
                    messages.push({
                        role: 'user',
                        content: 'Please use the write_file tool to create the files. Do not respond with code in text.'
                    });
                } else {
                    console.log('Empty response');
                    break;
                }

            } catch (error) {
                console.log('API Error:', error.message);
                break;
            }

            // Small delay between iterations
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`\nAgent completed in ${iterations} iterations`);
        console.log('Files created:', Array.from(files.keys()));

        // Save results
        const agentReport = {
            iterations,
            finished,
            files: Array.from(files.entries()).map(([path, content]) => ({
                path,
                length: content?.length || 0,
                preview: content?.substring(0, 200)
            }))
        };
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'agent-3d-report.json'),
            JSON.stringify(agentReport, null, 2)
        );

        // If we got files, try to render them
        if (files.size > 0) {
            const htmlContent = files.get('index.html');
            if (htmlContent) {
                const allFiles = Array.from(files.entries()).map(([path, content]) => ({ path, content }));
                const fullHtml = buildHtmlDocument(allFiles);

                if (fullHtml) {
                    fs.writeFileSync(path.join(OUTPUT_DIR, 'agent-3d.html'), fullHtml);

                    const renderResult = await renderAndCapture(browser, fullHtml, 'agent-3d', 1);
                    console.log('\nRender result:', renderResult.pageInfo);
                    console.log('Errors:', renderResult.errors.length);

                    if (renderResult.errors.length > 0) {
                        console.log('Error details:');
                        renderResult.errors.forEach(e => console.log(`  - ${e.message}`));
                    }
                }
            }
        }

        expect(files.size).toBeGreaterThan(0);

    }, 300000);
});

// =============================================================================
// TOOL CALLING DIAGNOSTIC (if model supports it)
// =============================================================================

describe.skipIf(!runLiveTests)('Llama Tool Calling Diagnostic', () => {
    it('should test if llama can use tools', async () => {
        console.log('\n' + '='.repeat(70));
        console.log('TOOL CALLING TEST');
        console.log('='.repeat(70));

        const tools = [
            {
                type: 'function',
                function: {
                    name: 'write_file',
                    description: 'Write content to a file',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path' },
                            content: { type: 'string', description: 'File content' }
                        },
                        required: ['path', 'content']
                    }
                }
            }
        ];

        const messages = [
            {
                role: 'system',
                content: 'You are a developer assistant. Use the write_file tool to create files.'
            },
            {
                role: 'user',
                content: 'Create an index.html file with a Hello World heading.'
            }
        ];

        try {
            const response = await callLlamaAPI(messages, tools);

            console.log('\nTool calls received:', response.toolCalls.length);

            if (response.toolCalls.length > 0) {
                console.log('Tool call details:', JSON.stringify(response.toolCalls, null, 2));
                console.log('\n✓ Model successfully used tools!');
            } else {
                console.log('No tool calls - model responded with text instead');
                console.log('Text response:', response.content.substring(0, 500));
            }

            // Save results
            fs.writeFileSync(
                path.join(OUTPUT_DIR, 'tool-calling-test.json'),
                JSON.stringify({
                    toolCallsReceived: response.toolCalls.length,
                    toolCalls: response.toolCalls,
                    textResponse: response.content.substring(0, 1000)
                }, null, 2)
            );

        } catch (error) {
            console.log('Tool calling error:', error.message);
            // Tools might not be supported - that's diagnostic info
        }

    }, 60000);
});

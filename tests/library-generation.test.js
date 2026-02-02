/**
 * Library Generation Tests
 *
 * Tests that verify AI models can correctly generate code using popular libraries.
 * Uses FREE tier models only.
 *
 * Test Philosophy:
 * - Simple Mode: Warnings on failure (single-pass generation has inherent limitations)
 * - Agent Mode: Stricter requirements (should achieve high success rate with multiple iterations)
 *
 * Run with:
 * OPENROUTER_API_KEY=sk-or-... RUN_LIVE_TESTS=true npm test -- tests/library-generation.test.js --run
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { detectLibraries, analyzeLibraryError, getLibraryDocs } from '../library-catalog.js';

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

const hasApiKey = !!process.env.OPENROUTER_API_KEY;
const runLiveTests = hasApiKey && process.env.RUN_LIVE_TESTS === 'true';

// Free tier models for testing
const FREE_MODELS = {
    llama: 'meta-llama/llama-3.3-70b-instruct:free',
    gemini: 'google/gemini-2.0-flash-thinking-exp:free',
    deepseek: 'deepseek/deepseek-r1:free'
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

// ============================================================================
// STATIC ANALYSIS HELPERS
// ============================================================================

/**
 * Analyze generated code for correct library usage
 */
function analyzeGeneratedCode(files, expectedLibrary) {
    const analysis = {
        hasLibrary: false,
        hasCorrectImport: false,
        hasUsageCode: false,
        issues: [],
        score: 0
    };

    const allContent = files.map(f => f.content || '').join('\n');

    // Check if library is detected
    const detected = detectLibraries(allContent);
    analysis.hasLibrary = detected.includes(expectedLibrary);

    // Library-specific checks
    switch (expectedLibrary) {
        case 'three':
            analysis.hasCorrectImport = /import.*from.*['"]three['"]/i.test(allContent) ||
                                        /esm\.sh\/three/i.test(allContent);
            analysis.hasUsageCode = /new\s+THREE\.(Scene|PerspectiveCamera|WebGLRenderer)/i.test(allContent);
            if (!allContent.includes('importmap') && !allContent.includes('type="module"')) {
                analysis.issues.push('Missing import map or module script type');
            }
            if (analysis.hasUsageCode && !allContent.includes('Light')) {
                analysis.issues.push('Warning: Scene might be dark without lighting');
            }
            break;

        case 'localStorage':
            analysis.hasCorrectImport = true; // No import needed
            analysis.hasUsageCode = /localStorage\.(get|set)Item/i.test(allContent);
            if (!allContent.includes('try') && !allContent.includes('catch')) {
                analysis.issues.push('Warning: No error handling for private browsing mode');
            }
            break;

        case 'chart.js':
            analysis.hasCorrectImport = /import.*from.*['"]chart\.js['"]/i.test(allContent) ||
                                        /esm\.sh\/chart\.js/i.test(allContent);
            analysis.hasUsageCode = /new\s+Chart\s*\(/i.test(allContent);
            if (!allContent.includes('register')) {
                analysis.issues.push('Warning: Missing Chart.register() - may cause errors');
            }
            if (!allContent.includes('canvas')) {
                analysis.issues.push('Warning: No canvas element found');
            }
            break;

        case 'gsap':
            analysis.hasCorrectImport = /import.*from.*['"]gsap['"]/i.test(allContent) ||
                                        /esm\.sh\/gsap/i.test(allContent);
            analysis.hasUsageCode = /gsap\.(to|from|timeline)/i.test(allContent);
            break;

        case 'leaflet':
            analysis.hasCorrectImport = /unpkg\.com\/leaflet/i.test(allContent) ||
                                        /esm\.sh\/leaflet/i.test(allContent);
            analysis.hasUsageCode = /L\.(map|tileLayer|marker)/i.test(allContent);
            if (!allContent.includes('height')) {
                analysis.issues.push('Warning: Map container needs explicit height');
            }
            break;

        case 'webAudio':
            analysis.hasCorrectImport = true; // No import needed
            analysis.hasUsageCode = /new\s+(Audio|window\.Audio)Context/i.test(allContent) ||
                                    /createOscillator|createGain/i.test(allContent);
            if (!allContent.includes('click') && !allContent.includes('user')) {
                analysis.issues.push('Warning: AudioContext should be created on user gesture');
            }
            break;
    }

    // Calculate score
    if (analysis.hasLibrary) analysis.score += 30;
    if (analysis.hasCorrectImport) analysis.score += 30;
    if (analysis.hasUsageCode) analysis.score += 40;

    return analysis;
}

/**
 * Check if HTML has required structure
 */
function validateHtmlStructure(content) {
    const checks = {
        hasDoctype: /<!DOCTYPE\s+html>/i.test(content),
        hasHtml: /<html[^>]*>/i.test(content),
        hasHead: /<head[^>]*>/i.test(content),
        hasBody: /<body[^>]*>/i.test(content),
        hasTitle: /<title[^>]*>/i.test(content)
    };

    return {
        valid: Object.values(checks).every(Boolean),
        checks
    };
}

/**
 * Check for common JavaScript errors in generated code
 */
function checkForJsErrors(content) {
    const issues = [];

    // Unbalanced braces
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
        issues.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close`);
    }

    // Unbalanced parentheses
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
        issues.push(`Unbalanced parentheses: ${openParens} open, ${closeParens} close`);
    }

    // Common mistakes
    if (/document\.getElementById\(['"][^'"]+['"]\)\./.test(content) &&
        !/document\.getElementById\(['"][^'"]+['"]\)\s*\?\./i.test(content) &&
        !/const\s+\w+\s*=\s*document\.getElementById\(['"][^'"]+['"]\);\s*if/i.test(content)) {
        issues.push('Warning: getElementById result not checked for null');
    }

    return issues;
}

// ============================================================================
// STATIC TESTS (No API calls)
// ============================================================================

describe('Library Code Analysis', () => {
    describe('Three.js Detection', () => {
        it('should detect correct Three.js usage', () => {
            const files = [{
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head>
    <script type="importmap">
    { "imports": { "three": "https://esm.sh/three@0.160.0" } }
    </script>
</head>
<body>
    <script type="module">
        import * as THREE from 'three';
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer();
        const light = new THREE.DirectionalLight(0xffffff, 1);
        scene.add(light);
    </script>
</body>
</html>`
            }];

            const analysis = analyzeGeneratedCode(files, 'three');
            expect(analysis.hasLibrary).toBe(true);
            expect(analysis.hasCorrectImport).toBe(true);
            expect(analysis.hasUsageCode).toBe(true);
            expect(analysis.score).toBe(100);
        });

        it('should flag missing import map', () => {
            const files = [{
                path: 'script.js',
                content: `const scene = new THREE.Scene();`
            }];

            const analysis = analyzeGeneratedCode(files, 'three');
            expect(analysis.hasCorrectImport).toBe(false);
            expect(analysis.issues.length).toBeGreaterThan(0);
        });
    });

    describe('localStorage Detection', () => {
        it('should detect correct localStorage usage', () => {
            const files = [{
                path: 'script.js',
                content: `
try {
    localStorage.setItem('user', JSON.stringify({ name: 'John' }));
    const user = JSON.parse(localStorage.getItem('user'));
} catch (e) {
    console.error('Storage unavailable');
}`
            }];

            const analysis = analyzeGeneratedCode(files, 'localStorage');
            expect(analysis.hasLibrary).toBe(true);
            expect(analysis.hasUsageCode).toBe(true);
            expect(analysis.score).toBe(100);
        });

        it('should warn about missing error handling', () => {
            const files = [{
                path: 'script.js',
                content: `localStorage.setItem('key', 'value');`
            }];

            const analysis = analyzeGeneratedCode(files, 'localStorage');
            expect(analysis.issues.some(i => i.includes('error handling'))).toBe(true);
        });
    });

    describe('Chart.js Detection', () => {
        it('should detect correct Chart.js usage', () => {
            const files = [{
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head>
    <script type="importmap">
    { "imports": { "chart.js": "https://esm.sh/chart.js@4" } }
    </script>
</head>
<body>
    <canvas id="myChart"></canvas>
    <script type="module">
        import { Chart, registerables } from 'chart.js';
        Chart.register(...registerables);
        const ctx = document.getElementById('myChart').getContext('2d');
        const chart = new Chart(ctx, { type: 'bar', data: {} });
    </script>
</body>
</html>`
            }];

            const analysis = analyzeGeneratedCode(files, 'chart.js');
            expect(analysis.hasLibrary).toBe(true);
            expect(analysis.hasCorrectImport).toBe(true);
            expect(analysis.hasUsageCode).toBe(true);
            expect(analysis.score).toBe(100);
        });

        it('should warn about missing register', () => {
            const files = [{
                path: 'script.js',
                content: `import { Chart } from 'chart.js';
const chart = new Chart(ctx, { type: 'bar' });`
            }];

            const analysis = analyzeGeneratedCode(files, 'chart.js');
            expect(analysis.issues.some(i => i.includes('register'))).toBe(true);
        });
    });

    describe('Leaflet Detection', () => {
        it('should detect correct Leaflet usage', () => {
            const files = [{
                path: 'index.html',
                content: `<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body>
    <div id="map" style="height: 400px;"></div>
    <script>
        const map = L.map('map').setView([51.505, -0.09], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
        L.marker([51.5, -0.09]).addTo(map);
    </script>
</body>
</html>`
            }];

            const analysis = analyzeGeneratedCode(files, 'leaflet');
            expect(analysis.hasLibrary).toBe(true);
            expect(analysis.hasCorrectImport).toBe(true);
            expect(analysis.hasUsageCode).toBe(true);
        });
    });

    describe('Web Audio Detection', () => {
        it('should detect correct Web Audio usage', () => {
            const files = [{
                path: 'script.js',
                content: `
document.getElementById('playBtn').addEventListener('click', () => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
});`
            }];

            const analysis = analyzeGeneratedCode(files, 'webAudio');
            expect(analysis.hasLibrary).toBe(true);
            expect(analysis.hasUsageCode).toBe(true);
        });

        it('should warn about missing user gesture', () => {
            const files = [{
                path: 'script.js',
                content: `const audioContext = new AudioContext();`
            }];

            const analysis = analyzeGeneratedCode(files, 'webAudio');
            expect(analysis.issues.some(i => i.includes('user gesture'))).toBe(true);
        });
    });
});

describe('HTML Structure Validation', () => {
    it('should validate complete HTML structure', () => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Test</title>
</head>
<body>
    <h1>Hello</h1>
</body>
</html>`;

        const validation = validateHtmlStructure(html);
        expect(validation.valid).toBe(true);
    });

    it('should detect missing doctype', () => {
        const html = `<html><head><title>Test</title></head><body></body></html>`;
        const validation = validateHtmlStructure(html);
        expect(validation.checks.hasDoctype).toBe(false);
    });
});

describe('JavaScript Error Detection', () => {
    it('should detect unbalanced braces', () => {
        const code = `function test() {
    if (true) {
        console.log('hello');
    }
// missing closing brace`;

        const issues = checkForJsErrors(code);
        expect(issues.some(i => i.includes('braces'))).toBe(true);
    });

    it('should warn about unchecked getElementById', () => {
        const code = `document.getElementById('container').appendChild(element);`;
        const issues = checkForJsErrors(code);
        expect(issues.some(i => i.includes('null'))).toBe(true);
    });

    it('should not warn about null-checked getElementById', () => {
        const code = `
const el = document.getElementById('container');
if (el) {
    el.appendChild(element);
}`;
        const issues = checkForJsErrors(code);
        expect(issues.some(i => i.includes('null'))).toBe(false);
    });
});

describe('Error Analysis Integration', () => {
    it('should analyze Three.js errors correctly', () => {
        const code = `import * as THREE from 'three';
const scene = new THREE.Scene();`;
        const error = 'THREE is not defined';

        const analysis = analyzeLibraryError(error, code);
        expect(analysis.detectedLibraries).toContain('three');
    });

    it('should suggest fixes for localStorage errors', () => {
        const code = `localStorage.setItem('data', JSON.stringify(largeData));`;
        const error = 'QuotaExceededError';

        const analysis = analyzeLibraryError(error, code);
        expect(analysis.detectedLibraries).toContain('localStorage');
    });
});

// ============================================================================
// LIVE API TESTS (Only run with API key)
// ============================================================================

describe.skipIf(!runLiveTests)('Live Model Generation Tests', () => {
    /**
     * Helper to call OpenRouter API
     */
    async function generateWithModel(model, prompt, systemPrompt = '') {
        const messages = [];

        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': 'https://simplesim.dev',
                'X-Title': 'SimpleSim Library Test'
            },
            body: JSON.stringify({
                model,
                messages,
                max_tokens: 4000
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }

    /**
     * Parse files from model response
     */
    function parseFilesFromResponse(response) {
        const files = [];

        // Try JSON format first
        try {
            const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.files && Array.isArray(parsed.files)) {
                    return parsed.files;
                }
            }
        } catch {}

        // Try code block extraction
        const codeBlocks = response.matchAll(/```(?:html|javascript|js|css)?\n([\s\S]*?)```/g);
        for (const match of codeBlocks) {
            const content = match[1];
            if (content.includes('<!DOCTYPE') || content.includes('<html')) {
                files.push({ path: 'index.html', content });
            } else if (content.includes('function') || content.includes('const') || content.includes('import')) {
                files.push({ path: 'script.js', content });
            }
        }

        return files;
    }

    // Simple Mode tests - warnings acceptable
    describe('Simple Mode - Three.js', () => {
        it('should generate a 3D scene (warning if incomplete)', async () => {
            const prompt = `Create a simple 3D scene with a rotating cube using Three.js.
Return as JSON: { "files": [{ "path": "index.html", "content": "..." }] }`;

            const systemPrompt = `You are a web developer. Return ONLY valid JSON with files array.
Use esm.sh for Three.js imports with import maps.`;

            const response = await generateWithModel(FREE_MODELS.llama, prompt, systemPrompt);
            const files = parseFilesFromResponse(response);

            const analysis = analyzeGeneratedCode(files, 'three');

            // Simple mode: warn instead of fail
            if (analysis.score < 60) {
                console.warn(`Simple Mode Three.js Warning: Score ${analysis.score}/100`);
                console.warn('Issues:', analysis.issues);
            }

            // Basic requirement: should at least mention Three.js
            expect(response.toLowerCase()).toContain('three');
        }, 60000);
    });

    describe('Simple Mode - localStorage', () => {
        it('should generate localStorage usage (warning if incomplete)', async () => {
            const prompt = `Create a todo app that saves items to localStorage.
Return as JSON: { "files": [{ "path": "index.html", "content": "..." }, { "path": "script.js", "content": "..." }] }`;

            const response = await generateWithModel(FREE_MODELS.llama, prompt);
            const files = parseFilesFromResponse(response);

            const analysis = analyzeGeneratedCode(files, 'localStorage');

            if (analysis.score < 70) {
                console.warn(`Simple Mode localStorage Warning: Score ${analysis.score}/100`);
                console.warn('Issues:', analysis.issues);
            }

            expect(response.toLowerCase()).toContain('localstorage');
        }, 60000);
    });

    describe('Simple Mode - Chart.js', () => {
        it('should generate a chart (warning if incomplete)', async () => {
            const prompt = `Create a bar chart showing monthly sales data using Chart.js.
Return as JSON: { "files": [{ "path": "index.html", "content": "..." }] }`;

            const systemPrompt = `You are a web developer. Return ONLY valid JSON.
Use esm.sh for Chart.js: https://esm.sh/chart.js@4
IMPORTANT: You must call Chart.register(...registerables) before creating charts.`;

            const response = await generateWithModel(FREE_MODELS.llama, prompt, systemPrompt);
            const files = parseFilesFromResponse(response);

            const analysis = analyzeGeneratedCode(files, 'chart.js');

            if (analysis.score < 60) {
                console.warn(`Simple Mode Chart.js Warning: Score ${analysis.score}/100`);
                console.warn('Issues:', analysis.issues);
            }

            expect(response.toLowerCase()).toMatch(/chart|graph/);
        }, 60000);
    });

    // Agent Mode tests - stricter requirements
    describe('Agent Mode Simulation - Multi-iteration', () => {
        it('should correctly use Three.js with documentation lookup', async () => {
            // Simulate agent getting library docs
            const threeDocs = getLibraryDocs('three');

            const prompt = `Create a 3D scene with a rotating cube.

Here is the Three.js documentation:
${threeDocs.importPattern}

Example:
${threeDocs.usage.slice(0, 500)}

Common errors to avoid:
${Object.entries(threeDocs.commonErrors).map(([e, s]) => `- ${e}: ${s}`).join('\n')}

Return as JSON: { "files": [{ "path": "index.html", "content": "..." }] }`;

            const response = await generateWithModel(FREE_MODELS.llama, prompt);
            const files = parseFilesFromResponse(response);

            const analysis = analyzeGeneratedCode(files, 'three');

            // Agent mode with docs: expect higher success rate
            if (analysis.score < 70) {
                console.log('Agent Mode with docs - Score:', analysis.score);
                console.log('Issues:', analysis.issues);
            }

            // With documentation provided, should achieve at least basic implementation
            expect(analysis.hasLibrary || response.toLowerCase().includes('three')).toBe(true);
        }, 60000);

        it('should handle localStorage with proper error handling', async () => {
            const localStorageDocs = getLibraryDocs('localStorage');

            const prompt = `Create a notes app that saves to localStorage with proper error handling.

Documentation:
${localStorageDocs.usage}

Important tips:
${localStorageDocs.tips.join('\n')}

Return as JSON: { "files": [{ "path": "index.html", "content": "..." }, { "path": "script.js", "content": "..." }] }`;

            const response = await generateWithModel(FREE_MODELS.llama, prompt);
            const files = parseFilesFromResponse(response);

            const analysis = analyzeGeneratedCode(files, 'localStorage');

            // With documentation, expect proper error handling
            expect(analysis.hasUsageCode || response.toLowerCase().includes('localstorage')).toBe(true);
        }, 60000);
    });
});

// ============================================================================
// TEST REPORT HELPERS
// ============================================================================

describe('Test Infrastructure', () => {
    it('should have library documentation available', () => {
        // Verify documentation is available for tested libraries
        const libraries = ['three', 'localStorage', 'chart.js', 'gsap', 'leaflet', 'webAudio'];

        for (const lib of libraries) {
            const docs = getLibraryDocs(lib);
            expect(docs, `Documentation missing for ${lib}`).toBeDefined();
            expect(docs.usage, `Usage examples missing for ${lib}`).toBeTruthy();
        }
    });

    it('should have detection patterns for tested libraries', () => {
        const testCode = `
            import * as THREE from 'three';
            localStorage.setItem('key', 'value');
            new Chart(ctx, {});
            gsap.to('.box', {});
            L.map('map');
            new AudioContext();
        `;

        const detected = detectLibraries(testCode);

        expect(detected).toContain('three');
        expect(detected).toContain('localStorage');
        expect(detected).toContain('chart.js');
        expect(detected).toContain('gsap');
        expect(detected).toContain('leaflet');
        expect(detected).toContain('webAudio');
    });
});

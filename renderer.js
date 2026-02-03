import { devLog, devError } from './thinking.js';

/**
 * Check if JavaScript content uses ES module syntax
 * @param {string} jsContent - JavaScript code to analyze
 * @returns {boolean} True if code uses import/export statements
 */
function isESModule(jsContent) {
    if (!jsContent) return false;

    // Patterns that indicate ES module syntax
    const modulePatterns = [
        /^\s*import\s+/m,                    // import X from
        /^\s*import\s*\{/m,                  // import { X } from
        /^\s*import\s*\*/m,                  // import * as X from
        /^\s*import\s+['"][^'"]+['"]/m,      // import 'module' (side-effect)
        /^\s*export\s+/m,                    // export statements
        /^\s*export\s*\{/m,                  // export { X }
        /^\s*export\s+default/m,             // export default
        /\bfrom\s+['"][^'"]+['"]/,           // from 'module'
    ];

    return modulePatterns.some(pattern => pattern.test(jsContent));
}

/**
 * Common library CDN mappings for import maps
 * These allow bare specifiers like `import * as THREE from 'three'` to work
 */
const LIBRARY_CDN_MAP = {
    'three': 'https://esm.sh/three@0.160.0',
    'three/': 'https://esm.sh/three@0.160.0/',
    'three/addons/': 'https://esm.sh/three@0.160.0/addons/',
    'three/examples/jsm/': 'https://esm.sh/three@0.160.0/examples/jsm/',
    '@tweenjs/tween.js': 'https://esm.sh/@tweenjs/tween.js@23.1.1',
    'gsap': 'https://esm.sh/gsap@3.12.5',
    'anime': 'https://esm.sh/animejs@3.2.2',
    'animejs': 'https://esm.sh/animejs@3.2.2',
    'd3': 'https://esm.sh/d3@7.8.5',
    'chart.js': 'https://esm.sh/chart.js@4.4.1',
    'pixi.js': 'https://esm.sh/pixi.js@7.4.0',
    'matter-js': 'https://esm.sh/matter-js@0.19.0',
    'p5': 'https://esm.sh/p5@1.9.0',
    'lodash': 'https://esm.sh/lodash-es@4.17.21',
    'lodash-es': 'https://esm.sh/lodash-es@4.17.21',
    'dayjs': 'https://esm.sh/dayjs@1.11.10',
    'uuid': 'https://esm.sh/uuid@9.0.1',
    'nipplejs': 'https://esm.sh/nipplejs@0.10.1',
};

/**
 * Detect bare specifiers in JavaScript code that would need import map
 * @param {string} jsContent - JavaScript code to analyze
 * @returns {string[]} Array of bare specifier names found
 */
function detectBareSpecifiers(jsContent) {
    if (!jsContent) return [];

    const found = new Set();

    // Match import statements with bare specifiers (not starting with ./ or ../ or http)
    // import X from 'specifier'
    // import { X } from 'specifier'
    // import * as X from 'specifier'
    const importRegex = /\bfrom\s+['"]([^'"./][^'"]*)['"]/g;
    let match;
    while ((match = importRegex.exec(jsContent)) !== null) {
        const specifier = match[1];
        // Check if it's in our known library map
        for (const key of Object.keys(LIBRARY_CDN_MAP)) {
            if (specifier === key || specifier.startsWith(key)) {
                found.add(key);
            }
        }
    }

    // Also check for dynamic imports
    const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
    while ((match = dynamicImportRegex.exec(jsContent)) !== null) {
        const specifier = match[1];
        for (const key of Object.keys(LIBRARY_CDN_MAP)) {
            if (specifier === key || specifier.startsWith(key)) {
                found.add(key);
            }
        }
    }

    return Array.from(found);
}

/**
 * Generate an import map script tag for the given specifiers
 * @param {string[]} specifiers - Bare specifier names to include
 * @returns {string} HTML script tag with import map
 */
function generateImportMap(specifiers) {
    const imports = {};

    for (const spec of specifiers) {
        if (LIBRARY_CDN_MAP[spec]) {
            imports[spec] = LIBRARY_CDN_MAP[spec];
        }
        // Also add subpath mappings if applicable
        const subpathKey = spec + '/';
        if (LIBRARY_CDN_MAP[subpathKey]) {
            imports[subpathKey] = LIBRARY_CDN_MAP[subpathKey];
        }
    }

    // Special handling for three.js - include common subpaths
    if (imports['three']) {
        imports['three/addons/'] = 'https://esm.sh/three@0.160.0/addons/';
        imports['three/examples/jsm/'] = 'https://esm.sh/three@0.160.0/examples/jsm/';
    }

    const importMapJson = JSON.stringify({ imports }, null, 2);

    return `<script type="importmap">
${importMapJson}
</script>`;
}

/**
 * Preview Error Store
 * Captures JavaScript errors and console messages from the preview iframe
 * for feeding back to the Agent during iteration
 */
const previewErrors = {
    errors: [],       // Runtime errors (window.onerror, unhandledrejection)
    consoleErrors: [], // console.error() calls
    consoleWarns: [],  // console.warn() calls
    lastRenderTime: null,
};

// Maximum number of errors/messages to store
const MAX_ERRORS = 20;
const MAX_CONSOLE = 50;

/**
 * Clear all stored preview errors
 * Called before each new render to reset state
 */
export function clearPreviewErrors() {
    previewErrors.errors = [];
    previewErrors.consoleErrors = [];
    previewErrors.consoleWarns = [];
    previewErrors.lastRenderTime = Date.now();
}

/**
 * Get all preview errors and console messages
 * Used by Agent mode to check for runtime issues
 */
export function getPreviewErrors() {
    return {
        errors: [...previewErrors.errors],
        consoleErrors: [...previewErrors.consoleErrors],
        consoleWarns: [...previewErrors.consoleWarns],
        hasErrors: previewErrors.errors.length > 0 || previewErrors.consoleErrors.length > 0,
        lastRenderTime: previewErrors.lastRenderTime,
    };
}

/**
 * Add an error from the preview iframe
 * Called via postMessage from the iframe
 */
function addPreviewError(error) {
    if (previewErrors.errors.length < MAX_ERRORS) {
        previewErrors.errors.push({
            ...error,
            timestamp: Date.now(),
        });
    }
}

/**
 * Add a console message from the preview iframe
 */
function addConsoleMessage(type, args) {
    const message = args.map(arg => {
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg);
            } catch {
                return String(arg);
            }
        }
        return String(arg);
    }).join(' ');

    const entry = { message, timestamp: Date.now() };

    if (type === 'error' && previewErrors.consoleErrors.length < MAX_CONSOLE) {
        previewErrors.consoleErrors.push(entry);
    } else if (type === 'warn' && previewErrors.consoleWarns.length < MAX_CONSOLE) {
        previewErrors.consoleWarns.push(entry);
    }
}

// Listen for messages from preview iframe
if (typeof window !== 'undefined') {
    window.addEventListener('message', (event) => {
        // Security: only accept messages from same origin or blob: URLs
        if (event.origin !== window.location.origin && !event.origin.startsWith('null')) {
            return;
        }

        const { type, data } = event.data || {};

        if (type === 'preview-error') {
            addPreviewError(data);
            devLog('Preview error captured:', data.message);
        } else if (type === 'preview-console') {
            addConsoleMessage(data.level, data.args);
        }
    });
}

/**
 * Render project files in the preview iframe
 * Combines HTML, CSS, and JS into a single document
 *
 * IMPORTANT: This replaces external file references (script.js, styles.css)
 * with inline content since we can't serve files from localhost
 */
export function renderProject(files) {
    const preview = document.getElementById('site-preview');
    const welcomeScreen = document.getElementById('welcome-screen');

    if (!files || !Array.isArray(files) || !preview) {
        devError('Invalid files or preview element');
        return;
    }

    // Clear previous errors before rendering new content
    clearPreviewErrors();

    devLog('Rendering project with files:', files.map(f => f.path));

    // Hide welcome screen
    welcomeScreen?.classList.add('hidden');

    // Find main files
    const htmlFile = files.find(f => f.path === 'index.html');
    const cssFile = files.find(f => f.path === 'styles.css' || f.path === 'style.css');
    const jsFile = files.find(f => f.path === 'script.js' || f.path === 'main.js' || f.path === 'app.js');

    // Find additional CSS/JS files
    const additionalCss = files.filter(f =>
        f.path.endsWith('.css') && f.path !== 'styles.css' && f.path !== 'style.css'
    );
    const additionalJs = files.filter(f =>
        f.path.endsWith('.js') && f.path !== 'script.js' && f.path !== 'main.js' && f.path !== 'app.js'
    );

    // Build a map of all JS and CSS files for reference replacement
    const jsFiles = new Map();
    const cssFiles = new Map();
    for (const f of files) {
        if (f.path.endsWith('.js')) {
            jsFiles.set(f.path, f.content);
            // Also map without leading ./
            jsFiles.set(f.path.replace(/^\.\//, ''), f.content);
        }
        if (f.path.endsWith('.css')) {
            cssFiles.set(f.path, f.content);
            cssFiles.set(f.path.replace(/^\.\//, ''), f.content);
        }
    }

    if (!htmlFile) {
        devError("No index.html found in files:", files.map(f => f.path));
        preview.srcdoc = `
            <html>
            <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666;">
                <div style="text-align:center;">
                    <h2>No index.html found</h2>
                    <p>The generated project is missing an index.html file.</p>
                </div>
            </body>
            </html>
        `;
        return;
    }

    // Start with the HTML content
    let combinedHTML = htmlFile.content;

    // Remove external script references that we'll inline (prevents NS_BINDING_ABORTED errors)
    // Match <script src="script.js"></script> or similar local file references
    // IMPORTANT: Preserve type="module" for ES module scripts
    combinedHTML = combinedHTML.replace(
        /<script\s+([^>]*)src\s*=\s*["'](?!https?:\/\/|\/\/)([^"']+\.js)["']([^>]*)>\s*<\/script>/gi,
        (match, beforeSrc, src, afterSrc) => {
            const content = jsFiles.get(src) || jsFiles.get(src.replace(/^\.\//, ''));
            if (content) {
                // Check if original tag had type="module" OR if content uses ES module syntax
                const originalAttrs = beforeSrc + afterSrc;
                const hadModuleType = /type\s*=\s*["']module["']/i.test(originalAttrs);
                const contentNeedsModule = isESModule(content);
                const useModule = hadModuleType || contentNeedsModule;

                const moduleAttr = useModule ? ' type="module"' : '';
                devLog(`Inlining script: ${src}${useModule ? ' (as module)' : ''}`);
                return `<script${moduleAttr}>/* Inlined: ${src} */\n${content}\n</script>`;
            }
            // If file not found in project, remove the reference to prevent load errors
            devLog(`Removing missing script reference: ${src}`);
            return `<!-- Script not found: ${src} -->`;
        }
    );

    // Remove external CSS references that we'll inline
    // Match <link rel="stylesheet" href="styles.css"> or similar
    combinedHTML = combinedHTML.replace(
        /<link\s+[^>]*href\s*=\s*["'](?!https?:\/\/|\/\/)([^"']+\.css)["'][^>]*\/?>/gi,
        (match, href) => {
            // Only process if it's a stylesheet
            if (!match.includes('stylesheet') && !match.includes('rel=')) {
                return match; // Keep non-stylesheet links
            }
            const content = cssFiles.get(href) || cssFiles.get(href.replace(/^\.\//, ''));
            if (content) {
                devLog(`Inlining stylesheet: ${href}`);
                return `<style>/* Inlined: ${href} */\n${content}\n</style>`;
            }
            // If file not found in project, remove the reference to prevent load errors
            devLog(`Removing missing stylesheet reference: ${href}`);
            return `<!-- Stylesheet not found: ${href} -->`;
        }
    );

    // Build CSS to inject (only files not already inlined above)
    let allCss = '';
    if (cssFile && !combinedHTML.includes(`/* Inlined: ${cssFile.path} */`)) {
        allCss += `/* ${cssFile.path} */\n${cssFile.content}\n`;
    }
    for (const css of additionalCss) {
        if (!combinedHTML.includes(`/* Inlined: ${css.path} */`)) {
            allCss += `/* ${css.path} */\n${css.content}\n`;
        }
    }

    // Build JS to inject (only files not already inlined above)
    let allJs = '';
    for (const js of additionalJs) {
        if (!combinedHTML.includes(`/* Inlined: ${js.path} */`)) {
            allJs += `// ${js.path}\n${js.content}\n`;
        }
    }
    if (jsFile && !combinedHTML.includes(`/* Inlined: ${jsFile.path} */`)) {
        allJs += `// ${jsFile.path}\n${jsFile.content}`;
    }

    // Inject CSS into head (only if we have non-inlined CSS)
    if (allCss) {
        const cssTag = `<style>\n${allCss}</style>`;
        if (combinedHTML.includes('</head>')) {
            combinedHTML = combinedHTML.replace('</head>', `${cssTag}\n</head>`);
        } else if (combinedHTML.includes('<body')) {
            combinedHTML = combinedHTML.replace('<body', `${cssTag}\n<body`);
        } else {
            combinedHTML = cssTag + combinedHTML;
        }
    }

    // Inject JS before closing body (only if we have non-inlined JS)
    // IMPORTANT: Detect if JS uses ES module syntax and add type="module" if needed
    if (allJs) {
        const needsModule = isESModule(allJs);
        const moduleAttr = needsModule ? ' type="module"' : '';
        if (needsModule) {
            devLog('Injected JS uses ES modules, adding type="module"');
        }

        // Check if JS uses bare specifiers that need import map
        const needsImportMap = needsModule && detectBareSpecifiers(allJs);
        if (needsImportMap.length > 0) {
            const importMap = generateImportMap(needsImportMap);
            devLog('Adding import map for:', needsImportMap);

            // Import map must be added before any module scripts
            if (combinedHTML.includes('<head>')) {
                combinedHTML = combinedHTML.replace('<head>', `<head>\n${importMap}`);
            } else if (combinedHTML.includes('<html>')) {
                combinedHTML = combinedHTML.replace('<html>', `<html>\n<head>${importMap}</head>`);
            } else {
                combinedHTML = importMap + combinedHTML;
            }
        }

        const jsTag = `<script${moduleAttr}>\n${allJs}\n</script>`;
        if (combinedHTML.includes('</body>')) {
            combinedHTML = combinedHTML.replace('</body>', `${jsTag}\n</body>`);
        } else if (combinedHTML.includes('</html>')) {
            combinedHTML = combinedHTML.replace('</html>', `${jsTag}\n</html>`);
        } else {
            combinedHTML += jsTag;
        }
    }

    // Add comprehensive error handling for Agent feedback
    const errorHandler = `
    <script>
    (function() {
        // Capture JavaScript errors
        window.onerror = function(msg, url, line, col, error) {
            console.error('Preview Error:', msg, 'at line', line);
            try {
                window.parent.postMessage({
                    type: 'preview-error',
                    data: {
                        type: 'runtime',
                        message: String(msg),
                        line: line,
                        column: col,
                        stack: error?.stack || null
                    }
                }, '*');
            } catch(e) {}
            return false;
        };

        // Capture unhandled promise rejections
        window.addEventListener('unhandledrejection', function(event) {
            const reason = event.reason;
            const message = reason?.message || String(reason);
            console.error('Unhandled Promise Rejection:', message);
            try {
                window.parent.postMessage({
                    type: 'preview-error',
                    data: {
                        type: 'promise',
                        message: message,
                        stack: reason?.stack || null
                    }
                }, '*');
            } catch(e) {}
        });

        // Intercept console.error and console.warn
        const originalError = console.error;
        const originalWarn = console.warn;

        console.error = function(...args) {
            originalError.apply(console, args);
            try {
                window.parent.postMessage({
                    type: 'preview-console',
                    data: { level: 'error', args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)) }
                }, '*');
            } catch(e) {}
        };

        console.warn = function(...args) {
            originalWarn.apply(console, args);
            try {
                window.parent.postMessage({
                    type: 'preview-console',
                    data: { level: 'warn', args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)) }
                }, '*');
            } catch(e) {}
        };
    })();
    </script>
    `;

    if (combinedHTML.includes('<head>')) {
        combinedHTML = combinedHTML.replace('<head>', `<head>\n${errorHandler}`);
    } else {
        combinedHTML = errorHandler + combinedHTML;
    }

    devLog('Rendering combined HTML:', combinedHTML.length, 'chars');
    preview.srcdoc = combinedHTML;
}

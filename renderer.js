import { devLog, devError } from './thinking.js';

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
    combinedHTML = combinedHTML.replace(
        /<script\s+[^>]*src\s*=\s*["'](?!https?:\/\/|\/\/)([^"']+\.js)["'][^>]*>\s*<\/script>/gi,
        (match, src) => {
            const content = jsFiles.get(src) || jsFiles.get(src.replace(/^\.\//, ''));
            if (content) {
                devLog(`Inlining script: ${src}`);
                return `<script>/* Inlined: ${src} */\n${content}\n</script>`;
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
    if (allJs) {
        const jsTag = `<script>\n${allJs}\n</script>`;
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

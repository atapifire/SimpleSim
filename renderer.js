import { devLog, devError } from './thinking.js';

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

    // Add error handling wrapper for better debugging
    const errorHandler = `
    <script>
    window.onerror = function(msg, url, line, col, error) {
        console.error('Preview Error:', msg, 'at line', line);
        return false;
    };
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

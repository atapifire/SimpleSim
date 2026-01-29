import { devLog, devError } from './thinking.js';

/**
 * Render project files in the preview iframe
 * Combines HTML, CSS, and JS into a single document
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

    // Build CSS to inject
    let allCss = '';
    if (cssFile) {
        allCss += cssFile.content + '\n';
    }
    for (const css of additionalCss) {
        allCss += `/* ${css.path} */\n${css.content}\n`;
    }

    // Build JS to inject
    let allJs = '';
    for (const js of additionalJs) {
        allJs += `// ${js.path}\n${js.content}\n`;
    }
    if (jsFile) {
        allJs += jsFile.content;
    }

    // Inject CSS into head
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

    // Inject JS before closing body
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

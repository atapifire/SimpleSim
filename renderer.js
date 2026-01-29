export function renderProject(files) {
    const preview = document.getElementById('site-preview');
    if (!files || !Array.isArray(files) || !preview) {
        return; 
    }

    const htmlFile = files.find(f => f.path === 'index.html');
    const cssFile = files.find(f => f.path === 'styles.css');
    const jsFile = files.find(f => f.path === 'script.js');

    if (!htmlFile) {
        console.error("No index.html found");
        return;
    }

    // Combine into a single HTML document for the iframe
    let combinedHTML = htmlFile.content;

    // Inject CSS
    if (cssFile) {
        if (combinedHTML.includes('</head>')) {
            combinedHTML = combinedHTML.replace('</head>', `<style>${cssFile.content}</style></head>`);
        } else {
            combinedHTML += `<style>${cssFile.content}</style>`;
        }
    }

    // Inject JS
    if (jsFile) {
        if (combinedHTML.includes('</body>')) {
            combinedHTML = combinedHTML.replace('</body>', `<script>${jsFile.content}</script></body>`);
        } else {
            combinedHTML += `<script>${jsFile.content}</script>`;
        }
    }

    preview.srcdoc = combinedHTML;
}
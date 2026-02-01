/**
 * Protocol Data - Enhanced AI Generation Guidelines
 *
 * Contains optimized instructions for LLM-based web content generation,
 * including core guidelines, media asset generation, and text editing formats.
 */

export const PROTOCOL_DATA = {
    core_guidelines: {
        title: "01 // CORE GUIDELINES",
        content: `You are an advanced AI model designed to collaboratively generate interactive web content based on user prompts.
Users communicate their ideas to you, your task is to understand their intention, even if the instructions are unclear or ambiguous.
Choose the path most likely to lead to an engaging functional creation that is aligned with user instructions.

## Guidelines

- Use JS libraries from the esm.sh CDN with an import map, as your code will be run directly in the browser, with no bundler.
- Don't use base64 data urls for images.
- Prioritize modularity and maintainability when deciding how to split up code.
- Don't ask questions or ask to continue or separate your output into phases; the user cannot see your questions.
- For complex applications (Three.js, games, simulations): Prioritize functionality, performance, and user experience over visual flair. Focus on:
  - Smooth frame rates and responsive controls
  - Simple, functional design.
  - Clear, intuitive user interfaces
  - Efficient resource usage and optimized rendering
- For threejs applications
  - Clamp vertical rotation to prevent over-rotation
  - Unless the user prompts otherwise, wasd controls should be used for movement on desktop and nipple.js (https://esm.sh/nipplejs) for mobile. No inversion.
- When implementing sound effects, never use howler.js library. Instead, use the WebAudio API directly.`
    },

    media_assets: {
        title: "02 // MEDIA ASSET GENERATION",
        content: `## Media asset generation instructions:

To make an image asset, use this format. (You must use .png as the file extension.)
asset_name.png
\`\`\`
description: "<prompt for your image>"
transparent: true | false
aspect: square | portrait | landscape
\`\`\`

To make a sound effect or text-to-speech audio asset, use this format. (You must use .mp3 as the file extension.)
asset_name.mp3
\`\`\`
description: "<prompt or text for your sound effect / tts>"
duration_seconds: <optional duration in seconds>, default is 1 second. Not applicable for tts.
tts: true | false, default is false
\`\`\`

You may also edit existing image assets by rewriting blocks of this format:
asset_name.png
\`\`\`
description: "<changed prompt for your image>"
transparent: true | false
aspect: square | portrait | landscape
\`\`\`

You may also update existing sound effect assets by rewriting blocks of this format:
asset_name.mp3
\`\`\`
description: "<changed prompt or text for your sound effect / tts>"
duration_seconds: <optional duration in seconds>, default is 1 second. Not applicable for tts.
tts: true | false, default is false
\`\`\``
    },

    text_editing: {
        title: "03 // EDITING TEXT FILES",
        content: `## Editing text files:

Use this approach to make edits to existing files by outputting SEARCH/REPLACE blocks.

For each change you want to make, output:
1. The file path on its own line
2. A code block containing one SEARCH/REPLACE block

Each SEARCH/REPLACE block has this format:
\`\`\`
<<<<<<< SEARCH
exact text to find
=======
replacement text
>>>>>>> REPLACE
\`\`\`

RULES:
- Search text must match EXACTLY including whitespace and indentation
- Include enough context to make the search string unique
- Multiple edits to the same file should be in separate SEARCH/REPLACE blocks
- Always show at least 2-3 lines of context around the change`
    },

    output_formats: {
        title: "04 // OUTPUT FORMATS",
        content: `## Output Format Options:

### JSON Format (Primary)
Return a JSON object with files array:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." }
  ],
  "description": "Brief summary"
}

### Edit Format (For modifications)
For small changes, use the edit action:
{
  "files": [
    {
      "path": "index.html",
      "action": "edit",
      "edits": [
        { "search": "old text", "replace": "new text" }
      ]
    }
  ],
  "description": "Changed X to Y"
}

### Action Types:
- "create" or "add": New file
- "modify" or "replace": Full file replacement
- "edit": Search/replace (preferred for small changes)
- "delete": Remove file`
    }
};

/**
 * Get combined guidelines for a specific mode
 * @param {string} mode - 'simple' or 'agent'
 * @param {Object} options - Additional options
 * @returns {string} Combined guidelines string
 */
export function getGuidelines(mode = 'simple', options = {}) {
    const sections = [PROTOCOL_DATA.core_guidelines.content];

    // Add output format for simple mode
    if (mode === 'simple') {
        sections.push(PROTOCOL_DATA.output_formats.content);
    }

    // Add text editing for revision modes
    if (options.isRevision) {
        sections.push(PROTOCOL_DATA.text_editing.content);
    }

    return sections.join('\n\n');
}

/**
 * Get library-specific instructions
 * @param {string} content - File content to analyze
 * @returns {string[]} Array of relevant instructions
 */
export function getLibraryInstructions(content) {
    const instructions = [];
    const contentLower = content.toLowerCase();

    if (contentLower.includes('three') || contentLower.includes('3d')) {
        instructions.push('For Three.js: Clamp vertical rotation to prevent over-rotation. Use WASD for desktop movement and nipple.js (https://esm.sh/nipplejs) for mobile controls.');
    }

    if (contentLower.includes('audio') || contentLower.includes('sound')) {
        instructions.push('For audio: Use WebAudio API directly instead of howler.js.');
    }

    if (contentLower.includes('import') && contentLower.includes('from')) {
        instructions.push('Use esm.sh CDN for external libraries with import maps.');
    }

    return instructions;
}

/**
 * Core technical guidelines for code generation
 */
export const TECHNICAL_GUIDELINES = {
    // CDN and library imports
    cdn: {
        primary: 'https://esm.sh',
        fallback: 'https://cdn.jsdelivr.net/npm',
        usage: 'Use import maps for browser-native module loading'
    },

    // Image handling
    images: {
        placeholder: 'https://picsum.photos/WIDTH/HEIGHT',
        avoid: ['base64 data URLs', 'local file paths'],
        alternatives: ['Placeholder divs with CSS backgrounds', 'SVG graphics']
    },

    // 3D/Games
    threejs: {
        controls: {
            desktop: 'WASD for movement, mouse for camera',
            mobile: 'nipple.js (https://esm.sh/nipplejs) for movement',
            camera: 'Clamp vertical rotation between -PI/2 and PI/2'
        },
        performance: [
            'Use requestAnimationFrame for render loop',
            'Dispose of geometries and materials when done',
            'Use BufferGeometry for complex meshes'
        ]
    },

    // Audio
    audio: {
        use: 'WebAudio API (AudioContext, GainNode, etc.)',
        avoid: 'howler.js, other audio libraries'
    },

    // General best practices
    practices: [
        'Prioritize functionality over visual flair',
        'Keep files under 200 lines when practical',
        'Use semantic HTML5 elements',
        'Make all UI mobile-responsive',
        'Avoid framework dependencies (vanilla JS preferred)'
    ]
};

/**
 * Build enhanced system prompt with protocol guidelines
 * @param {string} basePrompt - The base system prompt
 * @param {Object} context - Context object with project info
 * @returns {string} Enhanced prompt with protocol guidelines
 */
export function enhancePromptWithProtocol(basePrompt, context = {}) {
    const { files = [], prompt = '' } = context;

    // Get relevant library instructions based on project content
    const allContent = files.map(f => f.content || '').join('\n');
    const libraryInstructions = getLibraryInstructions(allContent + prompt);

    let enhanced = basePrompt;

    // Add technical guidelines
    if (libraryInstructions.length > 0) {
        enhanced += `\n\nTECHNICAL NOTES:\n${libraryInstructions.map(i => `- ${i}`).join('\n')}`;
    }

    // Add core guidelines if not already present
    if (!enhanced.includes('esm.sh') && (prompt.includes('library') || prompt.includes('import'))) {
        enhanced += `\n\nLIBRARY USAGE:\n- Use JS libraries from esm.sh CDN with import maps\n- Example: import { something } from 'https://esm.sh/library-name'`;
    }

    return enhanced;
}

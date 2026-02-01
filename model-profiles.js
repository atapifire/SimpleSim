/**
 * Model Profiles System
 *
 * Detects model family from OpenRouter ID and provides optimized configurations
 * for each model family (Claude, GPT, Gemini, Llama, Mistral, DeepSeek, Qwen, etc.)
 */

// Model family detection patterns
const MODEL_FAMILIES = {
    claude: /^anthropic\/claude/i,
    gpt: /^openai\/gpt/i,
    o1: /^openai\/o1/i,
    gemini: /^google\/gemini/i,
    llama: /^meta-llama\//i,
    mistral: /^mistralai\//i,
    deepseek: /^deepseek\//i,
    qwen: /^qwen\//i,
    cohere: /^cohere\//i,
    perplexity: /^perplexity\//i
};

// Model-specific configurations
const MODEL_PROFILES = {
    claude: {
        contextWindow: 200000,
        outputLimit: 8192,
        strengths: ['code', 'json', 'tools', 'reasoning', 'long-context'],
        promptStyle: 'xml-tags',      // Uses <tags> for structure
        jsonReliability: 'high',
        toolSupport: 'native',
        preferEditFormat: true,       // Prefers search/replace over full rewrites
        completionStyle: 'thorough',  // Creates complete files naturally
        specialInstructions: [
            'Create complete, production-ready code',
            'Use structured XML tags for complex instructions',
            'Prefer search/replace over full file rewrites'
        ],
        codeGenHints: [
            'Always create index.html, styles.css, and script.js for non-trivial sites',
            'Use semantic HTML5 elements',
            'Add appropriate ARIA labels for accessibility'
        ]
    },
    gpt: {
        contextWindow: 128000,
        outputLimit: 16384,
        strengths: ['code', 'json', 'tools'],
        promptStyle: 'markdown',      // Prefers ### headers
        jsonReliability: 'high',
        toolSupport: 'native',
        preferEditFormat: true,
        completionStyle: 'thorough',
        specialInstructions: [
            'Be concise in explanations',
            'Always complete code blocks fully',
            'Create all necessary files for a working site'
        ],
        codeGenHints: [
            'Separate concerns: HTML structure, CSS styling, JS behavior',
            'Use modern ES6+ JavaScript features',
            'Include responsive design considerations'
        ]
    },
    o1: {
        contextWindow: 200000,
        outputLimit: 100000,
        strengths: ['reasoning', 'complex-tasks', 'code'],
        promptStyle: 'markdown',
        jsonReliability: 'high',
        toolSupport: 'none',          // o1 doesn't support tools
        preferEditFormat: false,
        specialInstructions: [
            'Extended reasoning model - use for complex tasks',
            'No tool/function calling support',
            'Best for planning and complex problem solving'
        ]
    },
    gemini: {
        contextWindow: 1000000,       // 1M for Gemini 1.5 Pro
        outputLimit: 8192,
        strengths: ['long-context', 'multimodal', 'code'],
        promptStyle: 'markdown',
        jsonReliability: 'medium',    // Sometimes adds commentary
        toolSupport: 'native',
        preferEditFormat: false,      // Can handle full files easily with 1M context
        completionStyle: 'verbose',   // May add extra explanation
        specialInstructions: [
            'OUTPUT JSON ONLY - no markdown, no explanations outside JSON',
            'Create complete multi-file projects',
            'Do not add commentary before or after the JSON'
        ],
        codeGenHints: [
            'Always return valid JSON with all required files',
            'Include index.html, styles.css, script.js for interactive sites',
            'Do not explain - just return the code'
        ]
    },
    llama: {
        contextWindow: 128000,
        outputLimit: 4096,
        strengths: ['code', 'reasoning'],
        promptStyle: 'markdown',
        jsonReliability: 'medium',
        toolSupport: 'limited',       // Works but less reliable
        preferEditFormat: true,
        completionStyle: 'needs-guidance',  // May stop early without explicit instructions
        specialInstructions: [
            'You MUST create complete files - never truncate code',
            'Always include index.html AND styles.css AND script.js',
            'Follow the exact JSON format specified - no extra text'
        ],
        codeGenHints: [
            'Create ALL files needed for a working website',
            'Do NOT stop after just creating HTML - add CSS and JS too',
            'Complete the entire request in one response'
        ]
    },
    mistral: {
        contextWindow: 32000,
        outputLimit: 4096,
        strengths: ['code', 'efficiency'],
        promptStyle: 'markdown',
        jsonReliability: 'medium',
        toolSupport: 'native',
        preferEditFormat: true,
        specialInstructions: [
            'Good for targeted edits',
            'May need format reinforcement',
            'Efficient with smaller context windows'
        ]
    },
    deepseek: {
        contextWindow: 64000,
        outputLimit: 8192,
        strengths: ['code-specialized', 'reasoning'],
        promptStyle: 'markdown',
        jsonReliability: 'high',
        toolSupport: 'limited',
        preferEditFormat: true,
        completionStyle: 'code-focused',
        specialInstructions: [
            'Create complete, working code files',
            'Focus on functionality over explanation',
            'Return valid JSON with all required files'
        ],
        codeGenHints: [
            'Excellent at generating multi-file web projects',
            'Use modern JavaScript patterns',
            'Include all files needed for a complete site'
        ]
    },
    qwen: {
        contextWindow: 32000,
        outputLimit: 4096,
        strengths: ['code', 'multilingual'],
        promptStyle: 'markdown',
        jsonReliability: 'medium',
        toolSupport: 'limited',
        preferEditFormat: true,
        specialInstructions: [
            'Good code generation',
            'May need format reinforcement'
        ]
    },
    cohere: {
        contextWindow: 128000,
        outputLimit: 4096,
        strengths: ['rag', 'enterprise'],
        promptStyle: 'markdown',
        jsonReliability: 'medium',
        toolSupport: 'native',
        preferEditFormat: true,
        specialInstructions: [
            'Strong RAG capabilities',
            'Good for document processing'
        ]
    },
    perplexity: {
        contextWindow: 128000,
        outputLimit: 4096,
        strengths: ['search', 'current-info'],
        promptStyle: 'markdown',
        jsonReliability: 'medium',
        toolSupport: 'none',
        preferEditFormat: false,
        specialInstructions: [
            'Includes web search in responses',
            'May not follow strict output formats'
        ]
    },
    default: {
        contextWindow: 32000,
        outputLimit: 4096,
        strengths: [],
        promptStyle: 'markdown',
        jsonReliability: 'low',
        toolSupport: 'none',
        preferEditFormat: false,
        completionStyle: 'needs-guidance',
        specialInstructions: [
            'Return ONLY valid JSON - no other text',
            'Create complete files - never truncate',
            'Include ALL files needed for a working website'
        ],
        codeGenHints: [
            'You MUST create index.html with complete HTML structure',
            'For anything interactive, also create styles.css and script.js',
            'Do not stop after creating just one file'
        ]
    }
};

/**
 * Detect the model family from an OpenRouter model ID
 * @param {string} modelId - OpenRouter model ID (e.g., 'anthropic/claude-3.5-sonnet')
 * @returns {string} - Model family name (e.g., 'claude', 'gpt', 'default')
 */
export function getModelFamily(modelId) {
    if (!modelId) return 'default';

    const lowerModelId = modelId.toLowerCase();

    for (const [family, pattern] of Object.entries(MODEL_FAMILIES)) {
        if (pattern.test(modelId)) {
            return family;
        }
    }

    // Additional heuristic checks for model names
    if (lowerModelId.includes('claude')) return 'claude';
    if (lowerModelId.includes('gpt-4') || lowerModelId.includes('gpt-3')) return 'gpt';
    if (lowerModelId.includes('gemini')) return 'gemini';
    if (lowerModelId.includes('llama')) return 'llama';
    if (lowerModelId.includes('mistral') || lowerModelId.includes('mixtral')) return 'mistral';
    if (lowerModelId.includes('deepseek')) return 'deepseek';
    if (lowerModelId.includes('qwen')) return 'qwen';

    return 'default';
}

/**
 * Get the full profile for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {object} - Model profile with all configurations
 */
export function getModelProfile(modelId) {
    const family = getModelFamily(modelId);
    const profile = MODEL_PROFILES[family] || MODEL_PROFILES.default;

    // Return a copy with the family name included
    return {
        ...profile,
        family,
        modelId
    };
}

/**
 * Get the safe context limit for a model (reserves space for output)
 * @param {string} modelId - OpenRouter model ID
 * @returns {number} - Safe context limit in tokens
 */
export function getContextLimit(modelId) {
    const profile = getModelProfile(modelId);
    // Reserve 40% of context for output to be safe
    return Math.floor(profile.contextWindow * 0.6);
}

/**
 * Get the maximum output tokens for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {number} - Maximum output tokens
 */
export function getOutputLimit(modelId) {
    const profile = getModelProfile(modelId);
    return profile.outputLimit;
}

/**
 * Determine if agent mode is recommended for this model
 * @param {string} modelId - OpenRouter model ID
 * @returns {boolean} - Whether agent mode is recommended
 */
export function shouldUseAgentMode(modelId) {
    const profile = getModelProfile(modelId);
    return profile.toolSupport === 'native' || profile.toolSupport === 'full';
}

/**
 * Check if a model prefers edit format over full file replacement
 * @param {string} modelId - OpenRouter model ID
 * @returns {boolean} - Whether to prefer search/replace edits
 */
export function prefersEditFormat(modelId) {
    const profile = getModelProfile(modelId);
    return profile.preferEditFormat === true;
}

/**
 * Get the prompt style for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {string} - Prompt style ('xml-tags' or 'markdown')
 */
export function getPromptStyle(modelId) {
    const profile = getModelProfile(modelId);
    return profile.promptStyle;
}

/**
 * Get the JSON reliability level for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {string} - JSON reliability ('high', 'medium', 'low')
 */
export function getJsonReliability(modelId) {
    const profile = getModelProfile(modelId);
    return profile.jsonReliability;
}

/**
 * Get tool support level for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {string} - Tool support level ('native', 'limited', 'none')
 */
export function getToolSupport(modelId) {
    const profile = getModelProfile(modelId);
    return profile.toolSupport;
}

/**
 * Get special instructions for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {string[]} - Array of special instructions
 */
export function getSpecialInstructions(modelId) {
    const profile = getModelProfile(modelId);
    return profile.specialInstructions || [];
}

/**
 * Check if the model has a specific strength
 * @param {string} modelId - OpenRouter model ID
 * @param {string} strength - Strength to check for
 * @returns {boolean} - Whether the model has the strength
 */
export function hasStrength(modelId, strength) {
    const profile = getModelProfile(modelId);
    return profile.strengths.includes(strength);
}

/**
 * Get code generation hints for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {string[]} - Array of code generation hints
 */
export function getCodeGenHints(modelId) {
    const profile = getModelProfile(modelId);
    return profile.codeGenHints || [];
}

/**
 * Get the completion style for a model
 * @param {string} modelId - OpenRouter model ID
 * @returns {string} - Completion style ('thorough', 'needs-guidance', 'verbose', 'code-focused')
 */
export function getCompletionStyle(modelId) {
    const profile = getModelProfile(modelId);
    return profile.completionStyle || 'needs-guidance';
}

/**
 * Check if model needs extra completion guidance
 * @param {string} modelId - OpenRouter model ID
 * @returns {boolean} - Whether extra guidance is needed
 */
export function needsCompletionGuidance(modelId) {
    const style = getCompletionStyle(modelId);
    return style === 'needs-guidance' || style === 'verbose';
}

// Export the raw profiles for advanced use cases
export { MODEL_PROFILES, MODEL_FAMILIES };

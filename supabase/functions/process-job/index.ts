/**
 * Process Job Edge Function
 *
 * Main background job processor:
 * 1. Claims a pending job atomically
 * 2. Retrieves user's API key from active session
 * 3. Runs AI generation (simple or agent mode)
 * 4. Saves progress for chunked agent execution
 * 5. Creates version on completion
 * 6. Triggers GitHub commit if configured
 *
 * Designed for 150-second Supabase Edge Function timeout.
 * Agent jobs use chunked execution with state persistence.
 */

import {
  decryptAES,
  fromBase64,
  fromHex,
} from '../_shared/crypto.ts';
import {
  createServiceClient,
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/supabase.ts';

const SESSION_SECRET = Deno.env.get('SESSION_ENCRYPTION_SECRET') ||
                       Deno.env.get('API_KEY_ENCRYPTION_SECRET');

// Timeout safety margin (stop 30s before function timeout)
// Supabase Edge Functions have a 150s limit, we use 120s max
const MAX_EXECUTION_MS = 120000; // 2 minutes total
const AGENT_ITERATION_TIMEOUT_MS = 60000; // 60s per iteration (free models are slower)

// ============================================
// Verbose Logging Helper
// Logs to console and optionally to job record
// ============================================
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
}

class JobLogger {
  private jobId: string | null = null;
  private serviceClient: ReturnType<typeof createServiceClient> | null = null;
  private logs: LogEntry[] = [];
  private startTime: number = Date.now();

  setContext(jobId: string, serviceClient: ReturnType<typeof createServiceClient>) {
    this.jobId = jobId;
    this.serviceClient = serviceClient;
    this.startTime = Date.now();
    this.logs = [];
  }

  private createEntry(level: LogEntry['level'], message: string, data?: Record<string, unknown>): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      duration_ms: Date.now() - this.startTime
    };
  }

  async log(level: LogEntry['level'], message: string, data?: Record<string, unknown>) {
    const entry = this.createEntry(level, message, data);
    this.logs.push(entry);

    // Console output
    const prefix = `[process-job:${this.jobId?.substring(0, 8) || 'init'}]`;
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';

    switch (level) {
      case 'error':
        console.error(`${prefix} ${message}${dataStr}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${message}${dataStr}`);
        break;
      case 'debug':
        console.log(`${prefix} [DEBUG] ${message}${dataStr}`);
        break;
      default:
        console.log(`${prefix} ${message}${dataStr}`);
    }

    // Write to database (non-blocking)
    if (this.jobId && this.serviceClient) {
      this.serviceClient
        .from('jobs')
        .update({ processing_log: this.logs })
        .eq('id', this.jobId)
        .then(() => {})
        .catch((err) => console.error('Failed to update job log:', err));
    }
  }

  info(message: string, data?: Record<string, unknown>) {
    return this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    return this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    return this.log('error', message, data);
  }

  debug(message: string, data?: Record<string, unknown>) {
    return this.log('debug', message, data);
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }
}

const logger = new JobLogger();

/**
 * Update job status message - shown to user in UI
 */
async function updateJobStatus(
  serviceClient: ReturnType<typeof createServiceClient>,
  jobId: string,
  statusMessage: string,
  extraData?: Record<string, unknown>
) {
  const updateData: Record<string, unknown> = {
    status_message: statusMessage,
    updated_at: new Date().toISOString()
  };
  if (extraData) {
    Object.assign(updateData, extraData);
  }

  await serviceClient
    .from('jobs')
    .update(updateData)
    .eq('id', jobId);

  console.log(`[process-job] Status: ${statusMessage}`);
}

/**
 * Retry configuration for different error types
 */
const RETRY_CONFIG = {
  // Routing errors - model temporarily unavailable (wait longer)
  routing: { maxRetries: 5, baseDelayMs: 5000, maxDelayMs: 60000 },
  // Rate limits - wait and retry
  rateLimit: { maxRetries: 3, baseDelayMs: 10000, maxDelayMs: 60000 },
  // Transient server errors
  transient: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
};

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, config: typeof RETRY_CONFIG.routing): number {
  const delay = Math.min(config.baseDelayMs * Math.pow(2, attempt - 1), config.maxDelayMs);
  // Add some jitter (±20%)
  const jitter = delay * 0.2 * (Math.random() - 0.5);
  return Math.floor(delay + jitter);
}

/**
 * Generate human-readable status message for a tool call
 */
function getToolStatusMessage(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
      return `Reading ${args.path || 'file'}...`;
    case 'read_file_section':
      return `Reading lines ${args.start_line}-${args.end_line} of ${args.path}...`;
    case 'write_file':
      return `Writing ${args.path || 'file'}...`;
    case 'edit_file': {
      const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
      return `Editing ${args.path} (${editCount} change${editCount !== 1 ? 's' : ''})...`;
    }
    case 'delete_file':
      return `Deleting ${args.path}...`;
    case 'list_files':
      return 'Listing project files...';
    case 'search_files':
      return `Searching for "${String(args.query || '').substring(0, 30)}"...`;
    case 'validate_file':
      return `Validating ${args.path}...`;
    case 'preview_site':
      return 'Rendering preview...';
    case 'get_preview_errors':
      return 'Checking for runtime errors...';
    case 'check_dom':
      return 'Checking DOM element references...';
    case 'validate_and_preview':
      return 'Running comprehensive validation...';
    case 'get_library_docs':
      return `Looking up ${args.library || 'library'} documentation...`;
    case 'search_libraries':
      return `Searching libraries for "${args.query || ''}"...`;
    case 'finish':
      return 'Validating and finishing...';
    default:
      return `Running ${toolName}...`;
  }
}

interface JobData {
  id: string;
  user_id: string;
  project_id: string;
  job_type: 'simple' | 'agent';
  prompt: string;
  current_files: Array<{ path: string; content: string }>;
  model: string;
  api_key_id: string | null;
  is_child_request: boolean;
  safety_system_prompt: string | null;
  training_opt_out: boolean;
  current_iteration: number;
  max_iterations: number;
  working_files: Array<{ path: string; content: string }>;
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
}

interface FileResult {
  path: string;
  content: string;
  action?: 'add' | 'modify' | 'delete' | 'edit';
  edits?: Array<{ search: string; replace: string }>;
}

// ============================================
// Model Profiles (Server-side version)
// ============================================

interface ModelProfile {
  family: string;
  contextWindow: number;
  outputLimit: number;
  promptStyle: 'xml-tags' | 'markdown';
  jsonReliability: 'high' | 'medium' | 'low';
  preferEditFormat: boolean;
}

const MODEL_PROFILES: Record<string, Omit<ModelProfile, 'family'>> = {
  claude: {
    contextWindow: 200000,
    outputLimit: 8192,
    promptStyle: 'xml-tags',
    jsonReliability: 'high',
    preferEditFormat: true,
  },
  gpt: {
    contextWindow: 128000,
    outputLimit: 16384,
    promptStyle: 'markdown',
    jsonReliability: 'high',
    preferEditFormat: true,
  },
  gemini: {
    contextWindow: 1000000,
    outputLimit: 8192,
    promptStyle: 'markdown',
    jsonReliability: 'medium',
    preferEditFormat: false,
  },
  llama: {
    contextWindow: 128000,
    outputLimit: 4096,
    promptStyle: 'markdown',
    jsonReliability: 'medium',
    preferEditFormat: true,
  },
  mistral: {
    contextWindow: 32000,
    outputLimit: 4096,
    promptStyle: 'markdown',
    jsonReliability: 'medium',
    preferEditFormat: true,
  },
  deepseek: {
    contextWindow: 64000,
    outputLimit: 8192,
    promptStyle: 'markdown',
    jsonReliability: 'high',
    preferEditFormat: true,
  },
  default: {
    contextWindow: 32000,
    outputLimit: 4096,
    promptStyle: 'markdown',
    jsonReliability: 'low',
    preferEditFormat: false,
  },
};

function getModelFamily(modelId: string): string {
  const lowerModel = modelId.toLowerCase();
  if (lowerModel.includes('claude') || lowerModel.startsWith('anthropic/')) return 'claude';
  if (lowerModel.includes('gpt') || lowerModel.startsWith('openai/gpt')) return 'gpt';
  if (lowerModel.includes('gemini') || lowerModel.startsWith('google/')) return 'gemini';
  if (lowerModel.includes('llama') || lowerModel.startsWith('meta-llama/')) return 'llama';
  if (lowerModel.includes('mistral') || lowerModel.startsWith('mistralai/')) return 'mistral';
  if (lowerModel.includes('deepseek')) return 'deepseek';
  return 'default';
}

function getModelProfile(modelId: string): ModelProfile {
  const family = getModelFamily(modelId);
  const profile = MODEL_PROFILES[family] || MODEL_PROFILES.default;
  return { ...profile, family };
}

// ============================================
// File Operations (Server-side version)
// ============================================

function applyEdits(
  fileContent: string,
  edits: Array<{ search: string; replace: string }>
): { success: boolean; content?: string; error?: string } {
  let content = fileContent;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const searchIndex = content.indexOf(edit.search);

    if (searchIndex === -1) {
      return {
        success: false,
        error: `Edit ${i + 1}: Search string not found`,
      };
    }

    // Check for multiple occurrences
    const secondOccurrence = content.indexOf(edit.search, searchIndex + 1);
    if (secondOccurrence !== -1) {
      return {
        success: false,
        error: `Edit ${i + 1}: Search string found multiple times`,
      };
    }

    content =
      content.substring(0, searchIndex) +
      edit.replace +
      content.substring(searchIndex + edit.search.length);
  }

  return { success: true, content };
}

/**
 * Self-closing tags that don't need closing tags
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Common LLM truncation patterns
 */
/**
 * Common LLM truncation patterns
 * These are designed to catch LLM output that was cut off mid-syntax
 */
const TRUNCATION_PATTERNS = [
  /<[a-z][a-z0-9]*(?:\s+[^>]*)?$/i,   // Unclosed opening tag (no closing >)
  /<!--(?!.*-->).*$/s,                  // Unclosed comment (no -->)
  /<script[^>]*>(?![\s\S]*<\/script>)[\s\S]*$/i,  // Unclosed script
  /<style[^>]*>(?![\s\S]*<\/style>)[\s\S]*$/i,    // Unclosed style
  /=\s*["'][^"']*$/,                    // Unclosed attribute value (starts with = ")
];

/**
 * Detect if HTML is truncated (common LLM issue, especially with Llama 3.3)
 */
function detectHTMLTruncation(content: string): { truncated: boolean; reason?: string } {
  const trimmed = content.trim();

  // Check for truncation patterns
  for (const pattern of TRUNCATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { truncated: true, reason: 'Unclosed syntax at end of content' };
    }
  }

  // Check if HTML ends abruptly (no closing html or body)
  const hasHtmlTag = /<html[^>]*>/i.test(trimmed);
  const hasClosingHtml = /<\/html\s*>/i.test(trimmed);
  const hasBodyTag = /<body[^>]*>/i.test(trimmed);
  const hasClosingBody = /<\/body\s*>/i.test(trimmed);

  if (hasHtmlTag && !hasClosingHtml) {
    return { truncated: true, reason: 'Missing closing </html> tag' };
  }

  if (hasBodyTag && !hasClosingBody) {
    return { truncated: true, reason: 'Missing closing </body> tag' };
  }

  // Check for unclosed script/style tags
  const scriptOpens = (trimmed.match(/<script[^>]*>/gi) || []).length;
  const scriptCloses = (trimmed.match(/<\/script>/gi) || []).length;
  if (scriptOpens > scriptCloses) {
    return { truncated: true, reason: 'Unclosed <script> tag' };
  }

  const styleOpens = (trimmed.match(/<style[^>]*>/gi) || []).length;
  const styleCloses = (trimmed.match(/<\/style>/gi) || []).length;
  if (styleOpens > styleCloses) {
    return { truncated: true, reason: 'Unclosed <style> tag' };
  }

  return { truncated: false };
}

/**
 * Check if HTML tags are properly balanced
 */
function checkTagBalance(content: string): { balanced: boolean; unclosedTags: string[] } {
  const tagStack: string[] = [];
  const tagRegex = /<\/?([a-z][a-z0-9]*)[^>]*\/?>/gi;

  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();

    // Skip void elements and self-closing tags
    if (VOID_ELEMENTS.has(tagName)) continue;
    if (fullTag.endsWith('/>')) continue;
    if (fullTag.startsWith('<!') || fullTag.startsWith('<?')) continue;

    if (fullTag.startsWith('</')) {
      // Closing tag
      if (tagStack.length > 0 && tagStack[tagStack.length - 1] === tagName) {
        tagStack.pop();
      }
    } else {
      // Opening tag
      tagStack.push(tagName);
    }
  }

  return { balanced: tagStack.length === 0, unclosedTags: tagStack.reverse() };
}

/**
 * Attempt to repair broken HTML
 */
function repairHTML(content: string): { content: string; repairs: string[]; repaired: boolean } {
  let repaired = content;
  const repairs: string[] = [];

  // Add DOCTYPE if missing
  if (!/<!DOCTYPE\s+html>/i.test(repaired)) {
    repaired = '<!DOCTYPE html>\n' + repaired;
    repairs.push('Added DOCTYPE declaration');
  }

  // Wrap in html tag if missing
  if (!/<html[^>]*>/i.test(repaired)) {
    const doctypeMatch = repaired.match(/<!DOCTYPE[^>]*>/i);
    if (doctypeMatch) {
      const afterDoctype = repaired.substring(doctypeMatch.index! + doctypeMatch[0].length);
      repaired = doctypeMatch[0] + '\n<html lang="en">' + afterDoctype + '\n</html>';
    } else {
      repaired = '<html lang="en">\n' + repaired + '\n</html>';
    }
    repairs.push('Wrapped content in <html> tag');
  }

  // Add head if missing
  if (!/<head[^>]*>/i.test(repaired)) {
    const htmlMatch = repaired.match(/<html[^>]*>/i);
    if (htmlMatch) {
      const insertPos = htmlMatch.index! + htmlMatch[0].length;
      const defaultHead = `
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Page</title>
</head>`;
      repaired = repaired.substring(0, insertPos) + defaultHead + repaired.substring(insertPos);
      repairs.push('Added default <head> section');
    }
  }

  // Add body if missing
  if (!/<body[^>]*>/i.test(repaired)) {
    const headCloseMatch = repaired.match(/<\/head\s*>/i);
    if (headCloseMatch) {
      const insertPos = headCloseMatch.index! + headCloseMatch[0].length;
      const afterHead = repaired.substring(insertPos);
      const htmlCloseMatch = afterHead.match(/<\/html\s*>/i);
      if (htmlCloseMatch) {
        const bodyContent = afterHead.substring(0, htmlCloseMatch.index);
        const afterHtmlClose = afterHead.substring(htmlCloseMatch.index!);
        repaired = repaired.substring(0, insertPos) + '\n<body>' + bodyContent + '</body>\n' + afterHtmlClose;
        repairs.push('Wrapped content in <body> tag');
      }
    }
  }

  // Close unclosed tags
  const balance = checkTagBalance(repaired);
  if (!balance.balanced && balance.unclosedTags.length > 0) {
    for (const tag of balance.unclosedTags) {
      const bodyClose = repaired.lastIndexOf('</body>');
      const htmlClose = repaired.lastIndexOf('</html>');
      let insertPos = repaired.length;

      if (bodyClose > -1) {
        insertPos = bodyClose;
      } else if (htmlClose > -1) {
        insertPos = htmlClose;
      }

      repaired = repaired.substring(0, insertPos) + `</${tag}>` + repaired.substring(insertPos);
      repairs.push(`Added missing </${tag}> closing tag`);
    }
  }

  // Close unclosed script tags
  const scriptOpens = (repaired.match(/<script[^>]*>/gi) || []).length;
  const scriptCloses = (repaired.match(/<\/script>/gi) || []).length;
  if (scriptOpens > scriptCloses) {
    const diff = scriptOpens - scriptCloses;
    for (let i = 0; i < diff; i++) {
      repaired = repaired + '</script>';
      repairs.push('Added missing </script> closing tag');
    }
  }

  // Close unclosed style tags
  const styleOpens = (repaired.match(/<style[^>]*>/gi) || []).length;
  const styleCloses = (repaired.match(/<\/style>/gi) || []).length;
  if (styleOpens > styleCloses) {
    const diff = styleOpens - styleCloses;
    for (let i = 0; i < diff; i++) {
      repaired = repaired + '</style>';
      repairs.push('Added missing </style> closing tag');
    }
  }

  return { content: repaired, repairs, repaired: repairs.length > 0 };
}

/**
 * Validate and repair HTML files
 */
function validateAndRepairHTMLFiles(
  files: FileResult[]
): { files: FileResult[]; repairs: Array<{ path: string; repairs: string[] }> } {
  const repairedFiles: FileResult[] = [];
  const allRepairs: Array<{ path: string; repairs: string[] }> = [];

  for (const file of files) {
    const ext = file.path.split('.').pop()?.toLowerCase();

    if (ext === 'html' || ext === 'htm') {
      // Check for truncation or balance issues
      const truncation = detectHTMLTruncation(file.content);
      const balance = checkTagBalance(file.content);

      if (truncation.truncated || !balance.balanced) {
        const result = repairHTML(file.content);
        if (result.repaired) {
          repairedFiles.push({ path: file.path, content: result.content });
          allRepairs.push({ path: file.path, repairs: result.repairs });
          console.log(`[process-job] Auto-repaired ${file.path}: ${result.repairs.join(', ')}`);
        } else {
          repairedFiles.push(file);
        }
      } else {
        repairedFiles.push(file);
      }
    } else {
      repairedFiles.push(file);
    }
  }

  return { files: repairedFiles, repairs: allRepairs };
}

function validateFileSyntax(
  path: string,
  content: string
): { valid: boolean; error?: string; canRepair?: boolean } {
  const ext = path.split('.').pop()?.toLowerCase();

  if (ext === 'json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Invalid JSON: ${e.message}` };
    }
  }

  // Enhanced HTML validation
  if (ext === 'html' || ext === 'htm') {
    // Check for truncation first
    const truncation = detectHTMLTruncation(content);
    if (truncation.truncated) {
      return { valid: false, error: `HTML truncated: ${truncation.reason}`, canRepair: true };
    }

    // Check tag balance
    const balance = checkTagBalance(content);
    if (!balance.balanced) {
      return {
        valid: false,
        error: `Unbalanced HTML: unclosed tags [${balance.unclosedTags.join(', ')}]`,
        canRepair: true
      };
    }

    return { valid: true };
  }

  if (ext === 'css') {
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      return { valid: false, error: `Unbalanced braces: ${openBraces} vs ${closeBraces}` };
    }
  }

  return { valid: true };
}

// Starter template for new projects - minimal foundation
// No styling frameworks are forced - models choose what they need
const STARTER_FILES: FileResult[] = [
  {
    path: 'index.html',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Project</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <script src="script.js"></script>
</body>
</html>`
  },
  {
    path: 'style.css',
    content: `/* Add your styles here */`
  },
  {
    path: 'script.js',
    content: `// Add your JavaScript here`
  }
];

// Agent tools definition (enhanced with edit_file, read_file_section, validate_file)
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full content of a file in the project",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file_section",
      description: "Read a specific section of a file by line numbers. Use for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to read" },
          start_line: { type: "number", description: "Starting line number (1-indexed)" },
          end_line: { type: "number", description: "Ending line number (inclusive)" }
        },
        required: ["path", "start_line", "end_line"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with new content. Use for new files or complete rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to write" },
          content: { type: "string", description: "The complete file content" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make surgical edits using search/replace. More efficient than full file rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to edit" },
          edits: {
            type: "array",
            description: "Array of search/replace operations",
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "Exact text to find (must be unique)" },
                replace: { type: "string", description: "Text to replace it with" }
              },
              required: ["search", "replace"]
            }
          }
        },
        required: ["path", "edits"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to delete" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the project with sizes",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for text across all project files",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regex pattern to search for" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "validate_file",
      description: "Check if a file has valid syntax (HTML/JS/CSS/JSON)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file path to validate" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Signal that all changes are complete",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Brief summary of changes" }
        },
        required: ["summary"]
      }
    }
  }
];

Deno.serve(async (req) => {
  console.log('[process-job] Request received:', req.method, req.url);

  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Can be triggered by scheduler or directly
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const startTime = Date.now();
  let serviceClient;
  let jobData: JobData | null = null;

  // Log auth header info (not the actual token)
  const authHeader = req.headers.get('Authorization');
  console.log('[process-job] Auth header present:', !!authHeader);
  if (authHeader) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        console.log('[process-job] Token type:', payload.role || 'unknown');
        console.log('[process-job] Token sub:', payload.sub || 'none');
        console.log('[process-job] Token iss:', payload.iss || 'unknown');
      }
    } catch (e) {
      console.log('[process-job] Could not parse token');
    }
  }

  try {
    // Verify environment variables are set
    const envCheck = {
      SUPABASE_URL: !!Deno.env.get('SUPABASE_URL'),
      SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
      SESSION_SECRET: !!Deno.env.get('SESSION_ENCRYPTION_SECRET') || !!Deno.env.get('API_KEY_ENCRYPTION_SECRET'),
    };
    console.log('[process-job] Environment check:', envCheck);

    if (!envCheck.SUPABASE_URL || !envCheck.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[process-job] CRITICAL: Missing required environment variables');
      return errorResponse('Server configuration error: Missing Supabase credentials', 500);
    }

    console.log('[process-job] Creating service client...');
    serviceClient = createServiceClient();

    if (!serviceClient) {
      console.error('[process-job] CRITICAL: createServiceClient returned null/undefined');
      return errorResponse('Server configuration error: Failed to create service client', 500);
    }
    console.log('[process-job] Service client created successfully');
    // Check for specific job ID in request body, or claim next pending
    const body = await req.json().catch(() => ({}));

    if (body.jobId) {
      // Process a specific job (either resume processing or claim pending)
      const { data, error } = await serviceClient
        .from('jobs')
        .select('*')
        .eq('id', body.jobId)
        .single();

      if (error) {
        console.error('Error fetching job:', error);
        return jsonResponse({ error: 'Job not found: ' + error.message });
      }

      if (!data) {
        return jsonResponse({ error: 'Job not found' });
      }

      if (data.status === 'processing') {
        // Resume an already-processing job
        // But first check if it's been stuck too long (> 5 minutes)
        const lastHeartbeat = data.last_heartbeat ? new Date(data.last_heartbeat) : new Date(data.started_at || data.created_at);
        const stuckThreshold = 5 * 60 * 1000; // 5 minutes

        if (Date.now() - lastHeartbeat.getTime() > stuckThreshold) {
          console.log(`Job ${body.jobId} has been stuck for > 5 minutes, marking as failed`);
          await serviceClient.rpc('fail_job', {
            p_job_id: body.jobId,
            p_error_message: 'Job timed out - no heartbeat for 5+ minutes',
          });
          return jsonResponse({ error: 'Job was stuck and has been marked as failed', recovered: true });
        }

        jobData = data as JobData;
      } else if (data.status === 'pending') {
        // Claim this specific pending job
        const { error: claimError } = await serviceClient
          .from('jobs')
          .update({
            status: 'processing',
            started_at: new Date().toISOString(),
            last_heartbeat: new Date().toISOString(),
          })
          .eq('id', body.jobId)
          .eq('status', 'pending'); // Only if still pending

        if (claimError) {
          console.error('Error claiming job:', claimError);
          return jsonResponse({ error: 'Failed to claim job' });
        }

        // Re-fetch the updated job
        const { data: claimedJob } = await serviceClient
          .from('jobs')
          .select('*')
          .eq('id', body.jobId)
          .single();

        jobData = claimedJob as JobData;
      } else {
        console.log(`Job ${body.jobId} has status ${data.status}, skipping`);
        return jsonResponse({ message: `Job already ${data.status}` });
      }
    } else {
      // Claim next pending job (for backwards compatibility)
      const { data, error } = await serviceClient.rpc('claim_pending_job');

      if (!error && data && data.length > 0) {
        jobData = data[0].job_data as JobData;
      }
    }

    if (!jobData) {
      return jsonResponse({ message: 'No pending jobs' });
    }

    // Initialize logger for this job
    logger.setContext(jobData.id, serviceClient);
    await logger.info('Job processing started', {
      job_type: jobData.job_type,
      model: jobData.model,
      prompt_length: jobData.prompt.length,
      files_count: jobData.current_files?.length || 0
    });

    // Get the user's API key from active session
    await logger.info('Retrieving API key from session', { user_id: jobData.user_id });
    console.log('[process-job] Getting API key for user:', jobData.user_id);

    let apiKey: string | null = null;
    try {
      apiKey = await getApiKeyFromSession(serviceClient, jobData.user_id);
      console.log('[process-job] getApiKeyFromSession result:', apiKey ? 'key found' : 'no key');
    } catch (sessionError) {
      console.error('[process-job] getApiKeyFromSession threw error:', sessionError);
      throw sessionError;
    }

    if (!apiKey) {
      await logger.error('No API key found in session');
      console.log('[process-job] Failing job - no API key');
      await serviceClient.rpc('fail_job', {
        p_job_id: jobData.id,
        p_error_message: 'No active session. Please unlock your API key first.',
      });
      return jsonResponse({ error: 'No active session' });
    }

    await logger.info('API key retrieved successfully', {
      key_prefix: apiKey.substring(0, 10) + '...',
      key_length: apiKey.length
    });

    // Build request headers for COPPA/GDPR compliance
    const headers = buildRequestHeaders(apiKey, jobData);
    await logger.info('Request headers built', {
      model: jobData.model,
      training_opt_out: jobData.training_opt_out
    });

    let result: { files: FileResult[]; description: string; iterations?: number };

    if (jobData.job_type === 'simple') {
      result = await runSimpleGeneration(jobData, apiKey, headers);
    } else {
      result = await runAgentGeneration(
        jobData,
        apiKey,
        headers,
        serviceClient,
        startTime
      );
    }

    // Create version in database
    const versionId = await createVersion(serviceClient, jobData, result);

    // Complete the job
    await serviceClient.rpc('complete_job', {
      p_job_id: jobData.id,
      p_result_files: result.files,
      p_description: result.description,
      p_version_id: versionId,
      p_tokens_used: 0, // TODO: Track from API response
      p_cost_cents: 0,
    });

    // Trigger GitHub commit (non-blocking)
    triggerGitHubCommit(serviceClient, jobData, result).catch(console.error);

    // Update spending for child accounts
    if (jobData.is_child_request) {
      await updateChildSpending(serviceClient, jobData, 0); // TODO: actual cost
    }

    return jsonResponse({
      success: true,
      jobId: jobData.id,
      versionId,
      filesCount: result.files.length,
      iterations: result.iterations,
    });

  } catch (error) {
    console.error('[process-job] JOB PROCESSING ERROR:', error);
    console.error('[process-job] Error message:', error.message);
    console.error('[process-job] Error name:', error.name);
    console.error('[process-job] Error stack:', error.stack);
    console.error('[process-job] Error stringified:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

    // Mark the job as failed if we have a job ID and service client
    if (jobData?.id && serviceClient) {
      const errorMessage = error.message || 'Unknown error during job processing';
      console.log(`[process-job] Marking job ${jobData.id} as failed with message: ${errorMessage}`);
      try {
        await serviceClient.rpc('fail_job', {
          p_job_id: jobData.id,
          p_error_message: errorMessage,
        });
        console.log(`[process-job] Job ${jobData.id} marked as failed`);
      } catch (failError) {
        console.error('[process-job] Failed to mark job as failed:', failError);
      }
    } else if (jobData?.id && !serviceClient) {
      console.error(`[process-job] Cannot mark job ${jobData.id} as failed - service client not initialized`);
    }

    return errorResponse('Job processing failed: ' + error.message, 500);
  }
});

/**
 * Get decrypted API key from user's active session
 * Multi-device support: finds ANY valid session for the user (from any device)
 * Since all devices share the same underlying API key, any session will work
 */
async function getApiKeyFromSession(
  client: ReturnType<typeof createServiceClient>,
  userId: string
): Promise<string | null> {
  console.log(`[getApiKeyFromSession] Looking for session for user ${userId}`);

  // Query for any valid session for this user (across all devices)
  // Order by expires_at DESC to prefer sessions with longest remaining time
  const { data: session, error: sessionError } = await client
    .from('active_sessions')
    .select('encrypted_combined_key, expires_at, device_id')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1);

  if (sessionError) {
    console.error('[getApiKeyFromSession] Error querying sessions:', sessionError);
    return null;
  }

  if (!session || session.length === 0) {
    console.log('[getApiKeyFromSession] No active session found for user');
    return null;
  }

  const activeSession = session[0];
  if (!activeSession.encrypted_combined_key) {
    console.log('[getApiKeyFromSession] Session exists but no encrypted key');
    return null;
  }

  console.log(`[getApiKeyFromSession] Found session from device ${activeSession.device_id || 'legacy'}, expiring at ${activeSession.expires_at}`);

  try {
    const encryptedData = JSON.parse(activeSession.encrypted_combined_key);
    console.log('[getApiKeyFromSession] Encrypted data has keys:', Object.keys(encryptedData));

    if (!SESSION_SECRET) {
      console.error('[getApiKeyFromSession] SESSION_SECRET not configured!');
      return null;
    }

    const sessionKey = fromHex(SESSION_SECRET.padEnd(64, '0').slice(0, 64));

    const decrypted = await decryptAES(
      fromBase64(encryptedData.ciphertext),
      fromBase64(encryptedData.iv),
      fromBase64(encryptedData.tag),
      sessionKey
    );

    const apiKey = new TextDecoder().decode(decrypted);
    console.log(`[getApiKeyFromSession] Successfully decrypted key (length: ${apiKey.length})`);

    // Validate the key format
    if (apiKey.startsWith('sk-or-')) {
      console.log('[getApiKeyFromSession] Key format looks valid (sk-or-...)');
    } else {
      console.error('[getApiKeyFromSession] WARNING: Key does not start with sk-or-, may be corrupted');
      console.error('[getApiKeyFromSession] Key preview:', apiKey.substring(0, 10) + '...');
    }

    return apiKey;
  } catch (error) {
    console.error('[getApiKeyFromSession] Failed to decrypt session key:', error);
    return null;
  }
}

/**
 * Build request headers for OpenRouter with COPPA/GDPR compliance
 */
function buildRequestHeaders(apiKey: string, jobData: JobData): HeadersInit {
  const headers: HeadersInit = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://simplesim.app',
    'X-Title': 'SimpleSim Background Job',
  };

  // Add data policy header for minors or opted-out users
  if (jobData.training_opt_out || jobData.is_child_request) {
    // @ts-ignore - custom header for OpenRouter
    headers['X-OpenRouter-Data-Policy'] = 'zero-retention';
  }

  return headers;
}

/**
 * Run simple (single-pass) generation
 */
async function runSimpleGeneration(
  jobData: JobData,
  apiKey: string,
  headers: HeadersInit
): Promise<{ files: FileResult[]; description: string }> {
  const isRevision = jobData.current_files && jobData.current_files.length > 0;

  const systemPrompt = isRevision
    ? buildRevisionSystemPrompt(jobData.current_files, jobData.model, jobData.prompt)
    : buildNewProjectSystemPrompt(jobData.model, jobData.prompt);

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  // Add safety prompt for child requests
  if (jobData.safety_system_prompt) {
    messages[0].content = jobData.safety_system_prompt + '\n\n' + messages[0].content;
  }

  if (isRevision) {
    messages.push({
      role: 'user',
      content: buildFileContext(jobData.current_files),
    });
  }

  messages.push({ role: 'user', content: jobData.prompt });

  // Retry logic for transient errors
  let response: Response | null = null;
  let lastError = '';
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: jobData.model,
          messages,
          stream: false,
        }),
      });

      // Retry on transient errors
      if (response.status === 429 || response.status >= 500) {
        const errorBody = await response.text();
        lastError = `HTTP ${response.status}: ${errorBody}`;
        console.warn(`[simple] Transient error, retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }

      break; // Success or non-retryable error
    } catch (fetchError) {
      lastError = fetchError.message;
      if (attempt < maxRetries) {
        console.warn(`[simple] Fetch error, retrying: ${fetchError.message}`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }

  if (!response) {
    throw new Error(`All ${maxRetries} retries failed: ${lastError}`);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    let errorMsg = `API error: ${response.status}`;
    let providerError = '';
    try {
      const errorJson = JSON.parse(errorBody);
      errorMsg = errorJson.error?.message || errorJson.message || errorMsg;
      providerError = errorJson.error?.metadata?.raw || '';
    } catch {}

    await logger.error('Simple mode API error', {
      status: response.status,
      error: errorMsg,
      provider_error: providerError
    });

    // Handle auth errors
    if (response.status === 401 || errorMsg.includes('User not found')) {
      throw new Error(`OpenRouter auth failed: ${errorMsg}. Please re-setup your API key.`);
    }

    // Handle routing errors (common with free models when providers are unavailable)
    if (errorMsg.includes('No matching route') || errorMsg.includes('not configured in the Gateway')) {
      const isFreeModel = jobData.model.includes(':free');
      let helpfulMsg = `Model "${jobData.model}" is temporarily unavailable`;
      if (isFreeModel) {
        helpfulMsg += '. Free model providers may be overloaded. Try again in a few minutes, or switch to a paid model for more reliable access.';
      } else {
        helpfulMsg += '. The model may be offline or not available through any provider. Try a different model.';
      }
      throw new Error(helpfulMsg);
    }

    // Handle provider errors
    if (response.status === 502 || errorMsg.toLowerCase().includes('provider')) {
      let helpfulMsg = `Provider returned error for model "${jobData.model}"`;
      if (providerError) helpfulMsg += `: ${providerError}`;
      else if (errorMsg !== `API error: ${response.status}`) helpfulMsg += `: ${errorMsg}`;
      helpfulMsg += '. Try selecting a different model.';
      throw new Error(helpfulMsg);
    }

    throw new Error(providerError ? `${errorMsg} (${providerError})` : errorMsg);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from AI');
  }

  const parsed = parseAIResponse(content);

  // Merge with existing files if revision
  if (isRevision) {
    parsed.files = mergeFiles(jobData.current_files, parsed.files);
  }

  // Auto-repair HTML files (handles truncation and missing tags from LLMs)
  const repairResult = validateAndRepairHTMLFiles(parsed.files);
  if (repairResult.repairs.length > 0) {
    await logger.info('Auto-repaired HTML files', {
      repairs: repairResult.repairs.map(r => `${r.path}: ${r.repairs.join(', ')}`)
    });
    parsed.files = repairResult.files;
  }

  // CRITICAL: Ensure index.html exists
  const hasIndexHtml = parsed.files.some(f => f.path === 'index.html' || f.path === './index.html');
  if (!hasIndexHtml) {
    await logger.warn('Simple mode: No index.html found - creating fallback', {
      files: parsed.files.map(f => f.path)
    });

    // Create a minimal index.html
    const otherFiles = parsed.files.filter(f => f.path.endsWith('.html'));
    const links = otherFiles.length > 0
      ? otherFiles.map(f => `<li><a href="${f.path}">${f.path}</a></li>`).join('\n    ')
      : '<li>No additional pages</li>';

    const fallbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 1rem; }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; }
        ul { margin: 1rem 0; padding-left: 1.5rem; }
        li { margin: 0.5rem 0; }
        a { color: #3b82f6; }
        .note { background: #fef3c7; border: 1px solid #fcd34d; padding: 1rem; border-radius: 0.5rem; margin-top: 2rem; }
    </style>
</head>
<body>
    <h1>Project Files</h1>
    <p>The AI created the following files:</p>
    <ul>
    ${links}
    </ul>
    <div class="note">
        <p>Note: The AI didn't create a proper index.html. You may want to regenerate.</p>
    </div>
</body>
</html>`;

    parsed.files.unshift({ path: 'index.html', content: fallbackHtml });
  }

  return parsed;
}

/**
 * Run agent (multi-pass) generation with chunked execution
 */
async function runAgentGeneration(
  jobData: JobData,
  apiKey: string,
  headers: HeadersInit,
  serviceClient: ReturnType<typeof createServiceClient>,
  startTime: number
): Promise<{ files: FileResult[]; description: string; iterations: number }> {
  const isNewProject = !jobData.current_files || jobData.current_files.length === 0;

  // Initialize or restore state
  // For new projects, start with minimal HTML/CSS/JS files so models have a foundation
  let workingFiles = jobData.working_files.length > 0
    ? jobData.working_files
    : (isNewProject ? STARTER_FILES.map(f => ({ ...f })) : [...jobData.current_files]);

  let messages = jobData.messages.length > 0
    ? jobData.messages
    : [{ role: 'system', content: buildAgentSystemPrompt(isNewProject, jobData.safety_system_prompt, jobData.model, jobData.prompt) }];

  let iteration = jobData.current_iteration;
  let finished = false;
  let finalSummary = '';

  // Add initial context if starting fresh
  if (iteration === 0) {
    if (isNewProject) {
      // Tell the agent about the starter template
      messages.push({
        role: 'user',
        content: `STARTER TEMPLATE PROVIDED:\n- index.html (basic HTML5 + Tailwind CSS template)\n\nYou can read and modify this file. Build upon it to create the requested website.`,
      });
      messages.push({
        role: 'assistant',
        content: "I see the starter template. I'll build upon index.html to create the requested website, adding styles and JavaScript as needed.",
      });
    } else {
      const fileList = jobData.current_files.map(f => `- ${f.path}`).join('\n');
      messages.push({
        role: 'user',
        content: `CURRENT PROJECT FILES:\n${fileList}`,
      });
      messages.push({
        role: 'assistant',
        content: "I understand the project structure. I'll use read_file() to examine specific files as needed.",
      });
    }
    messages.push({ role: 'user', content: jobData.prompt });
  }

  // Agent loop
  while (!finished && iteration < jobData.max_iterations) {
    // Check time budget
    const elapsed = Date.now() - startTime;
    if (elapsed > MAX_EXECUTION_MS) {
      await logger.warn('Time budget exceeded, saving state for resume', {
        iteration,
        elapsed_ms: elapsed,
        max_ms: MAX_EXECUTION_MS
      });
      break;
    }

    iteration++;
    const iterationStart = Date.now();
    await logger.info(`Starting iteration ${iteration}/${jobData.max_iterations}`, {
      elapsed_ms: elapsed,
      messages_count: messages.length,
      working_files_count: workingFiles.length
    });

    // Update heartbeat
    await client
      .from('jobs')
      .update({ last_heartbeat: new Date().toISOString() })
      .eq('id', jobData.id);

    try {
      const requestBody = {
        model: jobData.model,
        messages,
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
      };

      await logger.info('Calling OpenRouter API', {
        model: jobData.model,
        messages_count: messages.length,
        has_tools: true
      });

      // Enhanced retry logic with specific handling for different error types
      let response: Response | null = null;
      let lastError = '';
      let routingRetryCount = 0;
      let rateLimitRetryCount = 0;
      const maxTransientRetries = 3;

      // Outer loop for routing/rate-limit retries (with longer waits)
      while (routingRetryCount <= RETRY_CONFIG.routing.maxRetries && rateLimitRetryCount <= RETRY_CONFIG.rateLimit.maxRetries) {

        // Inner loop for transient errors (quick retries)
        for (let attempt = 1; attempt <= maxTransientRetries; attempt++) {
          try {
            await updateJobStatus(serviceClient, jobData.id,
              `Iteration ${currentIteration + 1}: Calling AI model...`
            );

            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody),
              signal: AbortSignal.timeout(AGENT_ITERATION_TIMEOUT_MS),
            });

            console.log(`[process-job] OpenRouter response status: ${response.status} (attempt ${attempt})`);

            // Retry on server errors (5xx)
            if (response.status >= 500) {
              const errorBody = await response.text();
              lastError = `HTTP ${response.status}: ${errorBody}`;
              console.warn(`[process-job] Server error, retrying in ${attempt}s...`);
              await updateJobStatus(serviceClient, jobData.id,
                `Server error, retrying... (attempt ${attempt}/${maxTransientRetries})`
              );
              await new Promise(r => setTimeout(r, attempt * 1000));
              continue;
            }

            break; // Got a response (success or client error)
          } catch (fetchError) {
            lastError = fetchError.message;
            if (attempt < maxTransientRetries) {
              console.warn(`[process-job] Fetch error, retrying: ${fetchError.message}`);
              await updateJobStatus(serviceClient, jobData.id,
                `Connection error, retrying... (attempt ${attempt}/${maxTransientRetries})`
              );
              await new Promise(r => setTimeout(r, attempt * 1000));
            }
          }
        }

        if (!response) {
          await logger.error('All transient retries failed', { last_error: lastError });
          throw new Error(`API connection failed after ${maxTransientRetries} attempts: ${lastError}`);
        }

        // Check for retryable errors that need longer waits
        if (!response.ok) {
          const errorBody = await response.text();
          let errorMsg = `API error: ${response.status}`;
          try {
            const errorJson = JSON.parse(errorBody);
            errorMsg = errorJson.error?.message || errorJson.message || errorMsg;
          } catch {}

          // Handle routing errors with retry
          if (errorMsg.includes('No matching route') || errorMsg.includes('not configured in the Gateway')) {
            routingRetryCount++;
            if (routingRetryCount <= RETRY_CONFIG.routing.maxRetries) {
              const delay = getBackoffDelay(routingRetryCount, RETRY_CONFIG.routing);
              const delaySec = Math.round(delay / 1000);
              console.warn(`[process-job] Routing error, retry ${routingRetryCount}/${RETRY_CONFIG.routing.maxRetries} in ${delaySec}s...`);
              await logger.warn(`Model temporarily unavailable, waiting ${delaySec}s before retry`, {
                retry: routingRetryCount,
                max_retries: RETRY_CONFIG.routing.maxRetries,
                delay_ms: delay
              });
              await updateJobStatus(serviceClient, jobData.id,
                `Model temporarily unavailable, waiting ${delaySec}s... (retry ${routingRetryCount}/${RETRY_CONFIG.routing.maxRetries})`
              );
              await new Promise(r => setTimeout(r, delay));
              response = null; // Reset for next attempt
              continue;
            }
            // Max retries exceeded for routing
            const isFreeModel = jobData.model.includes(':free');
            let helpfulMsg = `Model "${jobData.model}" is unavailable after ${routingRetryCount} retries`;
            if (isFreeModel) {
              helpfulMsg += '. Free model providers may be overloaded. Try a paid model for more reliable access.';
            }
            throw new Error(helpfulMsg);
          }

          // Handle rate limiting with retry
          if (response.status === 429) {
            rateLimitRetryCount++;
            if (rateLimitRetryCount <= RETRY_CONFIG.rateLimit.maxRetries) {
              const delay = getBackoffDelay(rateLimitRetryCount, RETRY_CONFIG.rateLimit);
              const delaySec = Math.round(delay / 1000);
              console.warn(`[process-job] Rate limited, retry ${rateLimitRetryCount}/${RETRY_CONFIG.rateLimit.maxRetries} in ${delaySec}s...`);
              await logger.warn(`Rate limited, waiting ${delaySec}s before retry`, {
                retry: rateLimitRetryCount,
                max_retries: RETRY_CONFIG.rateLimit.maxRetries,
                delay_ms: delay
              });
              await updateJobStatus(serviceClient, jobData.id,
                `Rate limited, waiting ${delaySec}s... (retry ${rateLimitRetryCount}/${RETRY_CONFIG.rateLimit.maxRetries})`
              );
              await new Promise(r => setTimeout(r, delay));
              response = null; // Reset for next attempt
              continue;
            }
            throw new Error('Rate limit exceeded after multiple retries. Please wait a few minutes and try again.');
          }

          // Non-retryable error - break out of retry loop
          break;
        }

        // Success - break out of retry loop
        break;
      }

      if (!response) {
        await logger.error('All API retries exhausted', { last_error: lastError });
        throw new Error(`All retries failed: ${lastError}`);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMsg = `API error: ${response.status}`;
        let errorDetails: Record<string, unknown> = { status: response.status, body: errorBody.substring(0, 500) };
        let providerError = '';
        try {
          const errorJson = JSON.parse(errorBody);
          errorMsg = errorJson.error?.message || errorJson.message || errorMsg;
          providerError = errorJson.error?.metadata?.raw || '';
          errorDetails = { ...errorDetails, parsed_error: errorJson.error, provider_error: providerError };
        } catch {}
        await logger.error('OpenRouter API error', errorDetails);

        // Auth errors (not retryable)
        if (response.status === 401 || errorMsg.includes('User not found')) {
          throw new Error(`OpenRouter auth failed: ${errorMsg}. Please re-setup your API key.`);
        }

        // Provider errors with context
        if (response.status === 502 || errorMsg.toLowerCase().includes('provider')) {
          let helpfulMsg = `Provider returned error for model "${jobData.model}"`;
          if (providerError) {
            helpfulMsg += `: ${providerError}`;
          } else if (errorMsg !== `API error: ${response.status}`) {
            helpfulMsg += `: ${errorMsg}`;
          }
          helpfulMsg += '. Try selecting a different model or check your OpenRouter credits.';
          throw new Error(helpfulMsg);
        }

        // Generic error
        const fullError = providerError ? `${errorMsg} (${providerError})` : errorMsg;
        throw new Error(fullError);
      }

      const data = await response.json();
      const apiDuration = Date.now() - iterationStart;

      // Log detailed model response info
      await logger.info('OpenRouter API response received', {
        status: response.status,
        api_duration_ms: apiDuration,
        model: data.model,
        usage: data.usage,
        finish_reason: data.choices?.[0]?.finish_reason,
        has_tool_calls: !!data.choices?.[0]?.message?.tool_calls,
        tool_calls_count: data.choices?.[0]?.message?.tool_calls?.length || 0,
        content_length: data.choices?.[0]?.message?.content?.length || 0
      });

      // Store model info for analytics
      await client
        .from('jobs')
        .update({
          model_info: {
            model_used: data.model,
            usage: data.usage,
            last_iteration_duration_ms: apiDuration
          }
        })
        .eq('id', jobData.id);

      const message = data.choices?.[0]?.message;

      if (!message) {
        await logger.error('Empty response from model', {
          full_response: JSON.stringify(data).substring(0, 1000),
          choices_count: data.choices?.length || 0
        });
        throw new Error('Empty response from agent. Check logs for API response.');
      }

      const toolCalls = message.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        await logger.info('Processing tool calls', {
          tool_calls_count: toolCalls.length,
          tools: toolCalls.map((tc: { function: { name: string } }) => tc.function.name)
        });

        messages.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          // Generate human-readable status message for this tool
          const toolStatusMsg = getToolStatusMessage(toolName, toolArgs);
          await updateJobStatus(serviceClient, jobData.id,
            `Iteration ${currentIteration + 1}: ${toolStatusMsg}`
          );

          await logger.debug(`Executing tool: ${toolName}`, {
            tool: toolName,
            args_keys: Object.keys(toolArgs),
            path: toolArgs.path
          });

          const toolStart = Date.now();
          const result = executeAgentTool(toolName, toolArgs, workingFiles);
          const toolDuration = Date.now() - toolStart;

          await logger.info(`Tool executed: ${toolName}`, {
            tool: toolName,
            success: result.success !== false,
            duration_ms: toolDuration,
            finished: result.finished || false
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });

          if (result.finished) {
            finished = true;
            finalSummary = result.summary;
            await logger.info('Agent signaled completion', { summary: finalSummary });
            break;
          }

          // Update working files from write/delete/edit
          if (toolName === 'write_file') {
            workingFiles = updateWorkingFiles(workingFiles, toolArgs.path, toolArgs.content);
            await logger.debug('File written', { path: toolArgs.path, size: toolArgs.content?.length });
          } else if (toolName === 'delete_file') {
            workingFiles = workingFiles.filter(f => f.path !== toolArgs.path);
            await logger.debug('File deleted', { path: toolArgs.path });
          } else if (toolName === 'edit_file' && result.success && result.newContent) {
            workingFiles = updateWorkingFiles(workingFiles, toolArgs.path, result.newContent as string);
            await logger.debug('File edited', { path: toolArgs.path });
          }
        }
      } else if (message.content) {
        messages.push({ role: 'assistant', content: message.content });

        // Check if agent thinks it's done
        if (message.content.toLowerCase().includes('complete') ||
            message.content.toLowerCase().includes('finished')) {
          messages.push({
            role: 'user',
            content: 'Please call the finish() tool with a summary to complete the task.',
          });
        }
      }

      // Save progress after each iteration
      await client.rpc('update_job_progress', {
        p_job_id: jobData.id,
        p_iteration: iteration,
        p_working_files: workingFiles,
        p_messages: messages,
      });

    } catch (error) {
      console.error(`Agent iteration ${iteration} failed:`, error);
      throw error;
    }
  }

  // Check if we have files
  if (workingFiles.length === 0) {
    throw new Error('Agent produced no files');
  }

  // Auto-repair HTML files (handles truncation and missing tags from LLMs)
  const repairResult = validateAndRepairHTMLFiles(workingFiles);
  if (repairResult.repairs.length > 0) {
    await logger.info('Auto-repaired HTML files', {
      repairs: repairResult.repairs.map(r => `${r.path}: ${r.repairs.join(', ')}`)
    });
    workingFiles = repairResult.files;
  }

  // CRITICAL: Ensure index.html exists - this is required for the website to work
  const hasIndexHtml = workingFiles.some(f => f.path === 'index.html' || f.path === './index.html');
  if (!hasIndexHtml) {
    await logger.warn('No index.html found - creating fallback', {
      files: workingFiles.map(f => f.path)
    });

    // Create a minimal index.html that links to other files
    const otherFiles = workingFiles.filter(f => f.path.endsWith('.html'));
    const links = otherFiles.length > 0
      ? otherFiles.map(f => `<li><a href="${f.path}">${f.path}</a></li>`).join('\n    ')
      : '<li>No additional pages created</li>';

    const fallbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 1rem; }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; }
        ul { margin: 1rem 0; padding-left: 1.5rem; }
        li { margin: 0.5rem 0; }
        a { color: #3b82f6; }
        .note { background: #fef3c7; border: 1px solid #fcd34d; padding: 1rem; border-radius: 0.5rem; margin-top: 2rem; }
    </style>
</head>
<body>
    <h1>Project Files</h1>
    <p>The AI created the following files:</p>
    <ul>
    ${links}
    </ul>
    <div class="note">
        <p>Note: The AI didn't create a proper index.html. You may want to regenerate or edit this project.</p>
    </div>
</body>
</html>`;

    workingFiles.unshift({ path: 'index.html', content: fallbackHtml });
  }

  return {
    files: workingFiles,
    description: finalSummary || `Agent completed in ${iteration} iterations`,
    iterations: iteration,
  };
}

/**
 * Execute an agent tool (enhanced with edit_file, read_file_section, validate_file)
 */
function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  workingFiles: FileResult[]
): Record<string, unknown> {
  switch (name) {
    case 'read_file': {
      const file = workingFiles.find(f => f.path === args.path);
      if (file) {
        const lines = file.content.split('\n').length;
        return {
          success: true,
          content: file.content,
          lines,
          hint: lines > 200 ? 'Large file. Consider using read_file_section.' : undefined,
        };
      }
      return { success: false, error: `File not found: ${args.path}` };
    }

    case 'read_file_section': {
      const file = workingFiles.find(f => f.path === args.path);
      if (!file) {
        return { success: false, error: `File not found: ${args.path}` };
      }
      const lines = file.content.split('\n');
      const startLine = Math.max(1, Number(args.start_line) || 1);
      const endLine = Math.min(lines.length, Number(args.end_line) || lines.length);
      const section = lines.slice(startLine - 1, endLine);
      return {
        success: true,
        content: section.join('\n'),
        start_line: startLine,
        end_line: endLine,
        total_lines: lines.length,
      };
    }

    case 'write_file':
      return { success: true, message: `File written: ${args.path}` };

    case 'edit_file': {
      const file = workingFiles.find(f => f.path === args.path);
      if (!file) {
        return { success: false, error: `File not found: ${args.path}` };
      }
      const edits = args.edits as Array<{ search: string; replace: string }>;
      if (!edits || !Array.isArray(edits) || edits.length === 0) {
        return { success: false, error: 'No edits provided' };
      }
      const result = applyEdits(file.content, edits);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      // Note: actual file update is handled in the main loop
      return {
        success: true,
        message: `Applied ${edits.length} edit(s) to ${args.path}`,
        newContent: result.content,
      };
    }

    case 'delete_file': {
      const exists = workingFiles.some(f => f.path === args.path);
      return exists
        ? { success: true, message: `File deleted: ${args.path}` }
        : { success: false, error: `File not found: ${args.path}` };
    }

    case 'list_files':
      return {
        success: true,
        files: workingFiles.map(f => ({
          path: f.path,
          size: f.content.length,
          lines: f.content.split('\n').length,
        })),
      };

    case 'search_files': {
      const results: Array<{ path: string; matches: Array<{ line: number; content: string }> }> = [];
      const query = String(args.query);
      let regex: RegExp;
      try {
        regex = new RegExp(query, 'gi');
      } catch {
        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      }
      for (const file of workingFiles) {
        const matches: Array<{ line: number; content: string }> = [];
        const lines = file.content.split('\n');
        lines.forEach((line, i) => {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            matches.push({ line: i + 1, content: line.trim().substring(0, 100) });
          }
        });
        if (matches.length > 0) {
          results.push({ path: file.path, matches: matches.slice(0, 5) });
        }
      }
      return { success: true, results };
    }

    case 'validate_file': {
      const file = workingFiles.find(f => f.path === args.path);
      if (!file) {
        return { success: false, error: `File not found: ${args.path}` };
      }
      const validation = validateFileSyntax(String(args.path), file.content);
      return { success: true, valid: validation.valid, error: validation.error };
    }

    case 'finish':
      return { success: true, finished: true, summary: args.summary };

    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

/**
 * Update working files array
 */
function updateWorkingFiles(
  files: FileResult[],
  path: string,
  content: string
): FileResult[] {
  const index = files.findIndex(f => f.path === path);
  if (index >= 0) {
    files[index] = { path, content };
  } else {
    files.push({ path, content });
  }
  return files;
}

/**
 * Create version in database
 */
async function createVersion(
  client: ReturnType<typeof createServiceClient>,
  jobData: JobData,
  result: { files: FileResult[]; description: string }
): Promise<string> {
  const { data: version, error } = await client
    .from('versions')
    .insert({
      project_id: jobData.project_id,
      prompt: jobData.prompt,
      files: result.files,
      description: result.description,
      model_used: jobData.model,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error('Failed to create version: ' + error.message);
  }

  // Update project's current_files
  await client
    .from('projects')
    .update({ current_files: result.files })
    .eq('id', jobData.project_id);

  return version.id;
}

/**
 * Trigger GitHub commit (non-blocking)
 */
async function triggerGitHubCommit(
  client: ReturnType<typeof createServiceClient>,
  jobData: JobData,
  result: { files: FileResult[]; description: string }
): Promise<void> {
  // Check if project has GitHub repo linked
  const { data: project } = await client
    .from('projects')
    .select('github_repo')
    .eq('id', jobData.project_id)
    .single();

  if (!project?.github_repo) {
    return; // No repo linked
  }

  // Get user's GitHub token
  const { data: profile } = await client
    .from('profiles')
    .select('github_access_token')
    .eq('id', jobData.user_id)
    .single();

  if (!profile?.github_access_token) {
    console.log('No GitHub token for user, skipping commit');
    return;
  }

  // TODO: Implement GitHub commit via GitHub API
  // This would create a commit with the result files
  console.log(`Would commit to ${project.github_repo}:`, result.files.map(f => f.path));
}

/**
 * Update spending for child accounts
 */
async function updateChildSpending(
  client: ReturnType<typeof createServiceClient>,
  jobData: JobData,
  costCents: number
): Promise<void> {
  if (!jobData.api_key_id) return;

  await client
    .from('key_assignments')
    .update({ spent_cents: client.raw(`spent_cents + ${costCents}`) })
    .eq('api_key_id', jobData.api_key_id)
    .eq('child_user_id', jobData.user_id);
}

// ============================================
// Technical Notes Helper (context-aware guidelines)
// ============================================

/**
 * Build context-aware technical notes based on user prompt
 */
function buildTechnicalNotes(prompt: string): string {
  const notes: string[] = [];
  const promptLower = prompt.toLowerCase();

  // 3D/Three.js projects
  if (promptLower.includes('three') || promptLower.includes('3d') || promptLower.includes('webgl')) {
    notes.push('For Three.js/3D:');
    notes.push('- Use WASD for desktop movement, nipple.js (https://esm.sh/nipplejs) for mobile');
    notes.push('- Clamp vertical camera rotation to prevent over-rotation');
    notes.push('- Prioritize smooth frame rates and responsive controls');
  }

  // Game projects
  if (promptLower.includes('game') || promptLower.includes('simulation')) {
    notes.push('For games/simulations:');
    notes.push('- Focus on functionality and user experience over visual flair');
    notes.push('- Use requestAnimationFrame for render/update loops');
    notes.push('- Ensure responsive controls on both desktop and mobile');
  }

  // Audio/Sound
  if (promptLower.includes('sound') || promptLower.includes('audio') || promptLower.includes('music')) {
    notes.push('For audio:');
    notes.push('- Use WebAudio API directly (AudioContext, GainNode, etc.)');
    notes.push('- Do NOT use howler.js or other audio libraries');
  }

  // External libraries
  if (promptLower.includes('library') || promptLower.includes('import') || promptLower.includes('package')) {
    notes.push('For external libraries:');
    notes.push('- Use esm.sh CDN with import maps');
    notes.push('- Example: import { x } from "https://esm.sh/package-name"');
  }

  return notes.length > 0 ? notes.join('\n') : '';
}

// System prompt builders with model-specific optimizations
function buildNewProjectSystemPrompt(modelId?: string, userPrompt?: string): string {
  const profile = modelId ? getModelProfile(modelId) : getModelProfile('default');

  const criticalRules = `
CRITICAL RULES:
1. This is a STATIC WEBSITE builder - you create web projects
2. index.html is REQUIRED - it is the main entry point that users see first
3. You may create any file types needed (.html, .css, .js, .json, .txt, .md, etc.)
4. The main content should be in index.html - other files support it
5. Don't ask questions - the user cannot see your questions`;

  const requirements = `
REQUIREMENTS:
- index.html MUST be included (REQUIRED - this is the main page)
- Use Twind (Tailwind-compatible): <script src="https://cdn.twind.style" crossorigin></script>
- Clean, semantic HTML5
- Vanilla JavaScript (no frameworks)
- Images: https://picsum.photos/WIDTH/HEIGHT or placeholder divs (NO base64 data URLs)
- Mobile-responsive design`;

  // Get context-aware technical notes
  const technicalNotes = userPrompt ? buildTechnicalNotes(userPrompt) : '';

  if (profile.promptStyle === 'xml-tags') {
    return `<role>You are an expert Frontend Developer. Create a complete STATIC WEBSITE.</role>

<critical>${criticalRules}</critical>

<output_format>
Return ONLY valid JSON:
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    { "path": "styles.css", "content": "/* CSS */" }
  ],
  "description": "Brief description"
}
</output_format>

<requirements>${requirements}
</requirements>
${technicalNotes ? `\n<technical_notes>${technicalNotes}</technical_notes>` : ''}
<important>Output ONLY the JSON object. No markdown, no explanation. index.html is REQUIRED.</important>`;
  }

  return `You are an expert Frontend Developer. Create a complete STATIC WEBSITE.

${criticalRules}

### Output Format
Return **ONLY** valid JSON:
\`\`\`
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    { "path": "styles.css", "content": "/* CSS */" }
  ],
  "description": "Brief description"
}
\`\`\`
${requirements}
${technicalNotes ? `\n### Technical Notes\n${technicalNotes}` : ''}
**IMPORTANT**: Output ONLY the JSON object. No explanation. index.html is REQUIRED.`;
}

function buildRevisionSystemPrompt(files: FileResult[], modelId?: string, userPrompt?: string): string {
  const profile = modelId ? getModelProfile(modelId) : getModelProfile('default');
  const fileList = files.map(f => `- ${f.path}`).join('\n');

  const editInstructions = profile.preferEditFormat ? `
For SMALL changes, use "edit" action with search/replace:
{
  "path": "file.css",
  "action": "edit",
  "edits": [{ "search": "old text", "replace": "new text" }]
}
- Search strings must be UNIQUE and match EXACTLY
- Don't ask questions - the user cannot see your questions` : '';

  // Get context-aware technical notes
  const technicalNotes = userPrompt ? buildTechnicalNotes(userPrompt) : '';

  if (profile.promptStyle === 'xml-tags') {
    return `<role>You are an expert Frontend Developer. Modify an existing website.</role>

<project_files>
${fileList}
</project_files>

<output_format>
Return ONLY valid JSON:
{
  "files": [
    { "path": "...", "action": "modify|add|delete|edit", "content": "...", "edits": [...] }
  ],
  "description": "Changes made"
}
</output_format>

<actions>
- modify: Full file replacement
- add: New file
- delete: Remove file
- edit: Search/replace for small changes
</actions>
${editInstructions ? `<edit_format>${editInstructions}</edit_format>` : ''}
${technicalNotes ? `<technical_notes>${technicalNotes}</technical_notes>` : ''}
<rules>Only return files that CHANGE. NO base64 data URLs for images.</rules>`;
  }

  return `You are an expert Frontend Developer. Modify an existing website.

### Project Files
${fileList}

### Output Format
Return **ONLY** valid JSON:
\`\`\`json
{
  "files": [{ "path": "...", "action": "modify|add|delete|edit", "content": "...", "edits": [...] }],
  "description": "Changes made"
}
\`\`\`

### Actions
- \`modify\`: Full file replacement
- \`add\`: New file
- \`delete\`: Remove file
- \`edit\`: Search/replace for small changes
${editInstructions}
${technicalNotes ? `\n### Technical Notes\n${technicalNotes}` : ''}
Only return files that CHANGE. NO base64 data URLs for images.`;
}

function buildAgentSystemPrompt(isNewProject: boolean, safetyPrompt: string | null, modelId?: string, userPrompt?: string): string {
  const profile = modelId ? getModelProfile(modelId) : getModelProfile('default');
  let prompt = safetyPrompt ? safetyPrompt + '\n\n' : '';

  const toolDocs = `
- read_file(path): Read a file
- read_file_section(path, start_line, end_line): Read specific lines
- write_file(path, content): Create or overwrite file
- edit_file(path, edits): Surgical search/replace edits
- delete_file(path): Remove file
- list_files(): List all files with sizes
- search_files(query): Search across files
- validate_file(path): Check syntax
- finish(summary): Complete the task`;

  const efficiencyRules = `
EFFICIENCY:
- Use edit_file for small changes (avoids full rewrites)
- Use read_file_section for large files (>200 lines)
- Call validate_file after edits`;

  const criticalRules = `
CRITICAL RULES - YOU MUST FOLLOW THESE:
1. This is a STATIC WEBSITE builder. You create web projects.
2. index.html MUST exist - it is the main entry point. NEVER delete it.
3. You may create any file types needed (.html, .css, .js, .json, .txt, .md, etc.)
4. The main content should be in index.html - users see this first.
5. No server-side code (no PHP, Python, etc.) - static files only.
6. Don't ask questions - the user cannot see your questions.`;

  // Get context-aware technical notes
  const technicalNotes = userPrompt ? buildTechnicalNotes(userPrompt) : '';

  if (profile.promptStyle === 'xml-tags') {
    prompt += `<role>You are an expert Frontend Developer agent building STATIC WEBSITES.</role>

<critical>${criticalRules}</critical>

<tools>${toolDocs}
</tools>

<workflow>
1. ${isNewProject ? 'Read index.html to see the starter template' : 'Use list_files() to understand the project'}
2. Use edit_file to modify index.html with the requested content
3. Add styles.css and script.js if needed
4. Call finish() when done
</workflow>
${efficiencyRules}
<requirements>
- index.html MUST be the main page (REQUIRED)
- Use Twind (Tailwind-compatible): <script src="https://cdn.twind.style" crossorigin></script>
- Images: https://picsum.photos/WIDTH/HEIGHT (NO base64 data URLs)
- Mobile-responsive design
- Clean, semantic HTML5
</requirements>
${technicalNotes ? `<technical_notes>${technicalNotes}</technical_notes>` : ''}`;
  } else {
    prompt += `You are an expert Frontend Developer agent building STATIC WEBSITES.

${criticalRules}

### Tools${toolDocs}

### Workflow
1. ${isNewProject ? 'Read index.html to see the starter template' : 'Use list_files() to understand the project'}
2. Use edit_file to modify index.html with the requested content
3. Add styles.css and script.js if needed
4. Call finish() when done
${efficiencyRules}
### Requirements
- index.html MUST be the main page (REQUIRED)
- Use Twind (Tailwind-compatible): <script src="https://cdn.twind.style" crossorigin></script>
- Images: https://picsum.photos/WIDTH/HEIGHT (NO base64 data URLs)
- Mobile-responsive design
- Clean, semantic HTML5
${technicalNotes ? `\n### Technical Notes\n${technicalNotes}` : ''}`;
  }

  return prompt;
}

function buildFileContext(files: FileResult[]): string {
  return files.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');
}

function parseAIResponse(content: string): { files: FileResult[]; description: string } {
  // Try direct JSON parse
  try {
    const result = JSON.parse(content);
    if (result.files && Array.isArray(result.files)) {
      return result;
    }
  } catch {}

  // Try extracting from code blocks
  const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    try {
      const result = JSON.parse(match[1]);
      if (result.files) return result;
    } catch {}
  }

  // Try finding JSON boundaries
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const result = JSON.parse(content.slice(start, end + 1));
      if (result.files) return result;
    } catch {}
  }

  throw new Error('Failed to parse AI response as JSON');
}

function mergeFiles(existing: FileResult[], changes: FileResult[]): FileResult[] {
  const result = [...existing];

  for (const change of changes) {
    const action = change.action || 'modify';
    const index = result.findIndex(f => f.path === change.path);

    if (action === 'delete') {
      if (index >= 0) result.splice(index, 1);
    } else if (action === 'edit') {
      // Handle edit action with search/replace
      if (index >= 0 && change.edits && Array.isArray(change.edits)) {
        const editResult = applyEdits(result[index].content, change.edits);
        if (editResult.success && editResult.content) {
          result[index] = { path: change.path, content: editResult.content };
          console.log(`[mergeFiles] Applied ${change.edits.length} edits to ${change.path}`);
        } else {
          console.error(`[mergeFiles] Edit failed for ${change.path}: ${editResult.error}`);
        }
      }
    } else if (action === 'add' || index < 0) {
      result.push({ path: change.path, content: change.content });
    } else {
      result[index] = { path: change.path, content: change.content };
    }
  }

  return result;
}

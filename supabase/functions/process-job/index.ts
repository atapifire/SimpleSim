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
const MAX_EXECUTION_MS = 120000; // 2 minutes
const AGENT_ITERATION_TIMEOUT_MS = 25000; // 25s per iteration

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

function validateFileSyntax(
  path: string,
  content: string
): { valid: boolean; error?: string } {
  const ext = path.split('.').pop()?.toLowerCase();

  if (ext === 'json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Invalid JSON: ${e.message}` };
    }
  }

  // Basic checks for other file types
  if (ext === 'html' || ext === 'htm') {
    const trimmed = content.trim();
    if (trimmed.endsWith('<') || (trimmed.includes('<') && !trimmed.endsWith('>'))) {
      const lastOpen = trimmed.lastIndexOf('<');
      const lastClose = trimmed.lastIndexOf('>');
      if (lastOpen > lastClose) {
        return { valid: false, error: 'HTML appears truncated' };
      }
    }
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
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Can be triggered by scheduler or directly
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const startTime = Date.now();
  let serviceClient;
  let jobData: JobData | null = null;

  try {
    serviceClient = createServiceClient();
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

    console.log(`Processing job ${jobData.id} (${jobData.job_type})`);

    // Get the user's API key from active session
    console.log(`[process-job] Getting API key for user ${jobData.user_id}`);
    const apiKey = await getApiKeyFromSession(serviceClient, jobData.user_id);

    if (!apiKey) {
      console.error('[process-job] No API key found in session');
      await serviceClient.rpc('fail_job', {
        p_job_id: jobData.id,
        p_error_message: 'No active session. Please unlock your API key first.',
      });
      return jsonResponse({ error: 'No active session' });
    }

    // Log API key info (partial, for debugging)
    console.log(`[process-job] API key retrieved: ${apiKey.substring(0, 10)}... (length: ${apiKey.length})`);

    // Build request headers for COPPA/GDPR compliance
    const headers = buildRequestHeaders(apiKey, jobData);
    console.log(`[process-job] Using model: ${jobData.model}`);

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
    console.error('Job processing error:', error);
    console.error('Error stack:', error.stack);

    // Mark the job as failed if we have a job ID
    if (jobData?.id) {
      try {
        await serviceClient.rpc('fail_job', {
          p_job_id: jobData.id,
          p_error_message: error.message || 'Unknown error during job processing',
        });
        console.log(`Job ${jobData.id} marked as failed`);
      } catch (failError) {
        console.error('Failed to mark job as failed:', failError);
      }
    }

    return errorResponse('Job processing failed: ' + error.message, 500);
  }
});

/**
 * Get decrypted API key from user's active session
 */
async function getApiKeyFromSession(
  client: ReturnType<typeof createServiceClient>,
  userId: string
): Promise<string | null> {
  console.log(`[getApiKeyFromSession] Looking for session for user ${userId}`);

  const { data: session, error: sessionError } = await client
    .from('active_sessions')
    .select('encrypted_combined_key, expires_at')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
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

  console.log(`[getApiKeyFromSession] Found session expiring at ${activeSession.expires_at}`);

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
    ? buildRevisionSystemPrompt(jobData.current_files, jobData.model)
    : buildNewProjectSystemPrompt(jobData.model);

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
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
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

  return parsed;
}

/**
 * Run agent (multi-pass) generation with chunked execution
 */
async function runAgentGeneration(
  jobData: JobData,
  apiKey: string,
  headers: HeadersInit,
  client: ReturnType<typeof createServiceClient>,
  startTime: number
): Promise<{ files: FileResult[]; description: string; iterations: number }> {
  const isNewProject = !jobData.current_files || jobData.current_files.length === 0;

  // Initialize or restore state
  let workingFiles = jobData.working_files.length > 0
    ? jobData.working_files
    : (isNewProject ? [] : [...jobData.current_files]);

  let messages = jobData.messages.length > 0
    ? jobData.messages
    : [{ role: 'system', content: buildAgentSystemPrompt(isNewProject, jobData.safety_system_prompt, jobData.model) }];

  let iteration = jobData.current_iteration;
  let finished = false;
  let finalSummary = '';

  // Add initial context if starting fresh
  if (iteration === 0) {
    if (!isNewProject) {
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
      console.log(`Time budget exceeded at iteration ${iteration}, saving state`);
      break;
    }

    iteration++;
    console.log(`Agent iteration ${iteration}/${jobData.max_iterations}`);

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

      console.log(`[process-job] Calling OpenRouter with model: ${jobData.model}`);
      console.log(`[process-job] Message count: ${messages.length}`);

      // Retry logic for transient errors
      let response: Response | null = null;
      let lastError = '';
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(AGENT_ITERATION_TIMEOUT_MS),
          });

          console.log(`[process-job] OpenRouter response status: ${response.status} (attempt ${attempt})`);

          // Retry on transient errors
          if (response.status === 429 || response.status >= 500) {
            const errorBody = await response.text();
            lastError = `HTTP ${response.status}: ${errorBody}`;
            console.warn(`[process-job] Transient error, retrying in ${attempt}s...`);
            await new Promise(r => setTimeout(r, attempt * 1000));
            continue;
          }

          break; // Success or non-retryable error
        } catch (fetchError) {
          lastError = fetchError.message;
          if (attempt < maxRetries) {
            console.warn(`[process-job] Fetch error, retrying: ${fetchError.message}`);
            await new Promise(r => setTimeout(r, attempt * 1000));
          }
        }
      }

      if (!response) {
        throw new Error(`All ${maxRetries} retries failed: ${lastError}`);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[process-job] OpenRouter error: ${response.status} - ${errorBody}`);
        let errorMsg = `API error: ${response.status}`;
        try {
          const errorJson = JSON.parse(errorBody);
          errorMsg = errorJson.error?.message || errorJson.message || errorMsg;
        } catch {}
        throw new Error(errorMsg);
      }

      const data = await response.json();
      console.log(`[process-job] OpenRouter response data:`, JSON.stringify(data).substring(0, 500));

      const message = data.choices?.[0]?.message;

      if (!message) {
        console.error(`[process-job] No message in response. Full data:`, JSON.stringify(data));
        throw new Error('Empty response from agent. Check logs for API response.');
      }

      const toolCalls = message.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          const result = executeAgentTool(toolName, toolArgs, workingFiles);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });

          if (result.finished) {
            finished = true;
            finalSummary = result.summary;
            break;
          }

          // Update working files from write/delete/edit
          if (toolName === 'write_file') {
            workingFiles = updateWorkingFiles(workingFiles, toolArgs.path, toolArgs.content);
          } else if (toolName === 'delete_file') {
            workingFiles = workingFiles.filter(f => f.path !== toolArgs.path);
          } else if (toolName === 'edit_file' && result.success && result.newContent) {
            // Apply the edit result to working files
            workingFiles = updateWorkingFiles(workingFiles, toolArgs.path, result.newContent as string);
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

// System prompt builders with model-specific optimizations
function buildNewProjectSystemPrompt(modelId?: string): string {
  const profile = modelId ? getModelProfile(modelId) : getModelProfile('default');

  const requirements = `
- Always include index.html
- Use Tailwind CSS: <script src="https://cdn.tailwindcss.com"></script>
- Clean, semantic HTML5
- Vanilla JavaScript
- Mobile-responsive`;

  if (profile.promptStyle === 'xml-tags') {
    return `<role>You are an expert Frontend Developer. Create a complete static website.</role>

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

<critical>Output ONLY the JSON object. No markdown, no explanation.</critical>`;
  }

  return `You are an expert Frontend Developer. Create a complete static website.

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

### Requirements${requirements}

**CRITICAL**: Output ONLY the JSON object. No explanation.`;
}

function buildRevisionSystemPrompt(files: FileResult[], modelId?: string): string {
  const profile = modelId ? getModelProfile(modelId) : getModelProfile('default');
  const fileList = files.map(f => `- ${f.path}`).join('\n');

  const editInstructions = profile.preferEditFormat ? `
For SMALL changes, use "edit" action with search/replace:
{
  "path": "file.css",
  "action": "edit",
  "edits": [{ "search": "old text", "replace": "new text" }]
}` : '';

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
<rules>Only return files that CHANGE.</rules>`;
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
Only return files that CHANGE.`;
}

function buildAgentSystemPrompt(isNewProject: boolean, safetyPrompt: string | null, modelId?: string): string {
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

  if (profile.promptStyle === 'xml-tags') {
    prompt += `<role>You are an expert Frontend Developer agent.</role>

<tools>${toolDocs}
</tools>

<workflow>
1. ${isNewProject ? 'Plan the file structure' : 'Use list_files() to understand the project'}
2. Make changes using edit_file (preferred) or write_file
3. Validate with validate_file
4. Call finish() when done
</workflow>
${efficiencyRules}
<requirements>
- Include index.html
- Use Tailwind CSS
- Mobile-responsive
</requirements>`;
  } else {
    prompt += `You are an expert Frontend Developer agent.

### Tools${toolDocs}

### Workflow
1. ${isNewProject ? 'Plan the file structure' : 'Use list_files() to understand the project'}
2. Make changes using edit_file (preferred) or write_file
3. Validate with validate_file
4. Call finish() when done
${efficiencyRules}
### Requirements
- Include index.html
- Use Tailwind CSS
- Mobile-responsive`;
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

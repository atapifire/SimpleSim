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
  action?: 'add' | 'modify' | 'delete';
}

// Agent tools definition
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
      name: "write_file",
      description: "Create or overwrite a file with new content",
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
      description: "List all files in the project",
      parameters: { type: "object", properties: {}, required: [] }
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
  const serviceClient = createServiceClient();

  try {
    // Check for specific job ID in request body, or claim next pending
    const body = await req.json().catch(() => ({}));
    let jobData: JobData | null = null;

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
    const apiKey = await getApiKeyFromSession(serviceClient, jobData.user_id);

    if (!apiKey) {
      await serviceClient.rpc('fail_job', {
        p_job_id: jobData.id,
        p_error_message: 'No active session. Please unlock your API key first.',
      });
      return jsonResponse({ error: 'No active session' });
    }

    // Build request headers for COPPA/GDPR compliance
    const headers = buildRequestHeaders(apiKey, jobData);

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

    // Try to mark job as failed
    const body = await req.json().catch(() => ({}));
    if (body.jobId) {
      await serviceClient.rpc('fail_job', {
        p_job_id: body.jobId,
        p_error_message: error.message || 'Unknown error',
      });
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
    ? buildRevisionSystemPrompt(jobData.current_files)
    : buildNewProjectSystemPrompt();

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

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: jobData.model,
      messages,
      stream: false,
    }),
  });

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
    : [{ role: 'system', content: buildAgentSystemPrompt(isNewProject, jobData.safety_system_prompt) }];

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
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: jobData.model,
          messages,
          tools: AGENT_TOOLS,
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(AGENT_ITERATION_TIMEOUT_MS),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `API error: ${response.status}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;

      if (!message) {
        throw new Error('Empty response from agent');
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

          // Update working files from write/delete
          if (toolName === 'write_file') {
            workingFiles = updateWorkingFiles(workingFiles, toolArgs.path, toolArgs.content);
          } else if (toolName === 'delete_file') {
            workingFiles = workingFiles.filter(f => f.path !== toolArgs.path);
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
 * Execute an agent tool
 */
function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  workingFiles: FileResult[]
): Record<string, unknown> {
  switch (name) {
    case 'read_file': {
      const file = workingFiles.find(f => f.path === args.path);
      return file
        ? { success: true, content: file.content }
        : { success: false, error: `File not found: ${args.path}` };
    }

    case 'write_file':
      return { success: true, message: `File written: ${args.path}` };

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
        })),
      };

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

// System prompt builders
function buildNewProjectSystemPrompt(): string {
  return `You are an expert Frontend Developer. Create a complete static website.

OUTPUT FORMAT - Return ONLY valid JSON:
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    { "path": "styles.css", "content": "/* CSS */" }
  ],
  "description": "Brief description"
}

REQUIREMENTS:
- Always include index.html
- Use Tailwind CSS: <script src="https://cdn.tailwindcss.com"></script>
- Clean, semantic HTML5
- Vanilla JavaScript
- Mobile-responsive`;
}

function buildRevisionSystemPrompt(files: FileResult[]): string {
  const fileList = files.map(f => `- ${f.path}`).join('\n');
  return `You are an expert Frontend Developer. Modify an existing website.

PROJECT FILES:
${fileList}

OUTPUT FORMAT - Return ONLY valid JSON:
{
  "files": [{ "path": "...", "content": "...", "action": "modify" }],
  "description": "Changes made"
}

Only return files that CHANGE. Actions: "modify", "add", "delete"`;
}

function buildAgentSystemPrompt(isNewProject: boolean, safetyPrompt: string | null): string {
  let prompt = safetyPrompt ? safetyPrompt + '\n\n' : '';

  prompt += `You are an expert Frontend Developer agent.

TOOLS: read_file, write_file, delete_file, list_files, finish

WORKFLOW:
1. ${isNewProject ? 'Plan the file structure' : 'Use list_files() to understand the project'}
2. Make changes using write_file()
3. Call finish() when done

REQUIREMENTS:
- Include index.html
- Use Tailwind CSS
- Mobile-responsive`;

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
    } else if (action === 'add' || index < 0) {
      result.push({ path: change.path, content: change.content });
    } else {
      result[index] = { path: change.path, content: change.content };
    }
  }

  return result;
}

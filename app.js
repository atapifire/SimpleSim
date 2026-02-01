import { state, supabase, events, initAuth, signInWithGitHub, signOut } from './state.js';
import { security } from './security.js';
import { showToast, setLoading, setupVoiceInput } from './utils.js';
import { initSettings, startPinFlow } from './settings.js';
import { initProjects, loadProject, getCurrentFiles, createProject, createVersion } from './projects.js';
import { generateProject, checkCredits, fetchModelsWithCredits, refactorLargeFile, analyzeProjectHealth, formatTokenCount } from './ai.js';
import { thinking, isDev, devLog, devError } from './thinking.js';
import { getRefactoringSuggestions, getStatusColor } from './tokens.js';
import { runAgent, isAgentModeEnabled, setAgentMode, supportsToolCalling } from './agent.js';
import {
    initJobQueue,
    submitJob,
    subscribeToJob,
    setupJobFallback,
    cancelJob,
    checkCompletedJobs,
    getPendingJobs,
    getActiveJobProjectIds,
    getLastJobProjectId,
    clearLastJobProjectId,
    hasServerKey,
    checkSessionStatus,
    unlockSession,
    getSessionTimeRemaining,
    formatTimeRemaining,
    testAuth
} from './job-queue.js';

// --- Initialization ---
async function init() {
    // Initialize auth first
    await initAuth();

    // Inject auth UI
    injectAuthUI();

    // Inject model selector dropdown
    injectModelSelector();

    // Inject job progress UI
    injectJobProgressUI();

    // Initialize thinking UI
    thinking.init();

    initSettings();
    initProjects();
    setupEventListeners();
    setupModelSelector();
    setupAgentModeToggle();
    setupJobEventListeners();

    // Initialize background job queue
    await initJobQueue();

    // Dev mode indicator
    if (isDev) {
        devLog('Running in DEV mode');
        document.title = 'SimpleSim [DEV]';
    }

    // Expose debug functions globally
    window.testAuth = testAuth;
    window.supabase = supabase;
    window.state = state;
    window.checkJob = (id) => supabase.from('jobs').select('*').eq('id', id).single().then(r => console.log('Job:', r.data, r.error));
    window.checkSessions = () => supabase.from('active_sessions').select('*').then(r => console.log('Sessions:', r.data, r.error));
    window.checkJobs = () => supabase.from('jobs').select('id,status,created_at,user_id').order('created_at', {ascending:false}).limit(10).then(r => console.log('Jobs:', r.data, r.error));

    // Setup health indicator
    setupHealthIndicator();

    // Resume previous project if ID exists AND user is logged in
    if (state.projectId && state.user) {
        await loadProject(state.projectId);

        // Check for jobs completed while user was away
        await checkForCompletedJobsOnLoad();
    }

    // Check for any pending jobs
    await checkForPendingJobs();

    document.getElementById('prompt-input')?.focus();

    // Update model display
    updateModelDisplay();

    // Listen for version changes to update health
    events.addEventListener('version-changed', updateHealthIndicator);
}

// Inject login/logout button into the UI
function injectAuthUI() {
    const authContainer = document.createElement('div');
    authContainer.id = 'auth-container';
    authContainer.className = 'fixed top-4 right-4 z-50 pointer-events-auto';
    authContainer.innerHTML = `
        <div id="auth-loading" class="hidden">
            <div class="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin"></div>
        </div>
        <button id="btn-login" class="hidden bg-gray-800/90 backdrop-blur-lg border border-gray-700 px-4 py-2 rounded-xl text-sm font-medium text-white hover:bg-gray-700 transition-colors flex items-center gap-2">
            <i class="fa-brands fa-github"></i>
            Sign in with GitHub
        </button>
        <div id="user-menu" class="hidden flex items-center gap-3">
            <img id="user-avatar" src="" class="w-8 h-8 rounded-full border-2 border-gray-700" alt="Avatar">
            <span id="user-name" class="text-sm text-gray-300 hidden sm:block"></span>
            <button id="btn-logout" class="bg-gray-800/90 backdrop-blur-lg border border-gray-700 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                Sign out
            </button>
        </div>
    `;
    document.body.appendChild(authContainer);

    // Auth event listeners
    document.getElementById('btn-login')?.addEventListener('click', async () => {
        try {
            await signInWithGitHub();
        } catch (error) {
            showToast('Failed to sign in');
            console.error(error);
        }
    });

    document.getElementById('btn-logout')?.addEventListener('click', async () => {
        try {
            await signOut();
            showToast('Signed out');
            // Clear project state
            state.projectId = null;
            state.projects = [];
            state.versions = [];
            window.history.replaceState({}, '', window.location.pathname);
            document.getElementById('welcome-screen')?.classList.remove('hidden');
        } catch (error) {
            showToast('Failed to sign out');
        }
    });

    // Update UI based on auth state
    updateAuthUI();
    events.addEventListener('auth-changed', updateAuthUI);
}

function updateAuthUI() {
    const loading = document.getElementById('auth-loading');
    const loginBtn = document.getElementById('btn-login');
    const userMenu = document.getElementById('user-menu');
    const avatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');

    if (state.isAuthLoading) {
        loading?.classList.remove('hidden');
        loginBtn?.classList.add('hidden');
        userMenu?.classList.add('hidden');
    } else if (state.user) {
        loading?.classList.add('hidden');
        loginBtn?.classList.add('hidden');
        userMenu?.classList.remove('hidden');
        if (avatar) avatar.src = state.profile?.github_avatar_url || state.user.user_metadata?.avatar_url || '';
        if (userName) userName.textContent = state.profile?.github_username || state.user.user_metadata?.user_name || 'User';
    } else {
        loading?.classList.add('hidden');
        loginBtn?.classList.remove('hidden');
        userMenu?.classList.add('hidden');
    }
}

function setupEventListeners() {
    const input = document.getElementById('prompt-input');
    const btnSend = document.getElementById('btn-send');

    // Initialize button state
    if (btnSend) {
        btnSend.disabled = true;
        btnSend.classList.add('opacity-50');
    }

    // Input Auto-resize
    input?.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        const shouldDisable = !input.value.trim() || state.isGenerating;
        btnSend.disabled = shouldDisable;
        btnSend.classList.toggle('opacity-50', shouldDisable);
    });

    // Send Handlers - click works on both desktop and mobile
    btnSend?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!btnSend.disabled) {
            handleSend();
        }
    });

    // Backup touch handler for mobile
    btnSend?.addEventListener('touchend', (e) => {
        // Prevent double-firing with click
        if (e.cancelable) e.preventDefault();
        if (!btnSend.disabled) {
            handleSend();
        }
    });

    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    // Suggestions
    document.querySelectorAll('.suggestion-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            input.value = btn.dataset.prompt;
            input.dispatchEvent(new Event('input'));
            handleSend();
        });
    });
    
    // Voice
    setupVoiceInput(input, document.getElementById('btn-mic'));

    // Loading State Listener
    window.addEventListener('loading-state-changed', () => {
        btnSend.disabled = !input.value.trim() || state.isGenerating;
        btnSend.classList.toggle('opacity-50', btnSend.disabled);
    });

    // Retry Listener (from Settings/PIN flow)
    events.addEventListener('retry-generation', () => {
        if (state.pendingPrompt) handleSend(true);
    });

    // Auto-queue on page visibility change (for immediate mode)
    document.addEventListener('visibilitychange', async () => {
        if (document.hidden && state.immediateGeneration) {
            devLog('Page hidden during immediate generation - auto-queueing job');
            try {
                await autoQueueCurrentGeneration();
            } catch (error) {
                devError('Failed to auto-queue:', error);
            }
        }
    });

    // Warn user if leaving during generation
    window.addEventListener('beforeunload', (e) => {
        if (state.isGenerating || state.currentJob) {
            e.preventDefault();
            e.returnValue = 'Generation in progress. Your work may be lost if you leave.';
            return e.returnValue;
        }
    });
}

// --- Job Progress UI ---
function injectJobProgressUI() {
    const container = document.createElement('div');
    container.id = 'job-progress-container';
    container.className = 'fixed bottom-32 sm:bottom-24 left-1/2 -translate-x-1/2 z-40 hidden';
    container.innerHTML = `
        <div class="bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-2xl shadow-2xl p-3 sm:p-4 w-72 sm:w-96 max-w-[95vw]">
            <div class="flex items-center justify-between mb-2 sm:mb-3">
                <div class="flex items-center gap-2">
                    <div id="job-status-indicator" class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                    <span id="job-status-text" class="text-xs sm:text-sm font-medium text-white">Processing...</span>
                </div>
                <div class="flex items-center gap-1">
                    <button id="btn-toggle-logs" class="text-gray-400 hover:text-blue-400 transition-colors p-1" title="Show logs">
                        <i class="fa-solid fa-terminal text-xs"></i>
                    </button>
                    <button id="btn-cancel-job" class="text-gray-400 hover:text-red-400 transition-colors p-1" title="Cancel job">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
            </div>

            <div id="job-progress-bar-container" class="mb-3 hidden">
                <div class="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Agent Progress</span>
                    <span id="job-iteration-count">0/10</span>
                </div>
                <div class="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div id="job-progress-bar" class="h-full bg-purple-500 transition-all duration-300" style="width: 0%"></div>
                </div>
            </div>

            <!-- Processing Logs Panel (collapsible) -->
            <div id="job-logs-panel" class="hidden mb-3">
                <div class="text-xs text-gray-500 mb-1 flex justify-between items-center">
                    <span>Processing Log</span>
                    <span id="job-model-info" class="text-gray-600 text-[10px]"></span>
                </div>
                <div id="job-logs-content" class="bg-gray-950 rounded-lg p-2 max-h-40 overflow-y-auto text-[10px] sm:text-xs font-mono space-y-1">
                    <div class="text-gray-600">Waiting for logs...</div>
                </div>
            </div>

            <div class="flex items-center justify-between text-xs">
                <span id="job-elapsed-time" class="text-gray-500">Elapsed: 0s</span>
                <span class="text-green-400 flex items-center gap-1">
                    <i class="fa-solid fa-cloud text-[10px]"></i>
                    You can close this tab
                </span>
            </div>

            <div id="job-session-warning" class="hidden mt-3 p-2 bg-yellow-900/30 border border-yellow-700/50 rounded-lg">
                <div class="flex items-center gap-2 text-yellow-400 text-xs">
                    <i class="fa-solid fa-clock"></i>
                    <span>Session expires in <span id="session-time-remaining">--</span></span>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(container);

    // Cancel button handler
    document.getElementById('btn-cancel-job')?.addEventListener('click', handleCancelJob);

    // Toggle logs panel
    document.getElementById('btn-toggle-logs')?.addEventListener('click', () => {
        const panel = document.getElementById('job-logs-panel');
        const btn = document.getElementById('btn-toggle-logs');
        if (panel && btn) {
            panel.classList.toggle('hidden');
            btn.classList.toggle('text-blue-400');
            btn.classList.toggle('text-gray-400');
        }
    });
}

// Update job logs display
function updateJobLogs(logs, modelInfo) {
    const content = document.getElementById('job-logs-content');
    const modelInfoEl = document.getElementById('job-model-info');

    if (!content) return;

    if (!logs || logs.length === 0) {
        content.innerHTML = '<div class="text-gray-600">Waiting for logs...</div>';
        return;
    }

    // Build log entries HTML
    const html = logs.map(log => {
        const levelColors = {
            'info': 'text-blue-400',
            'warn': 'text-yellow-400',
            'error': 'text-red-400',
            'debug': 'text-gray-500'
        };
        const color = levelColors[log.level] || 'text-gray-400';
        const time = log.duration_ms ? `+${(log.duration_ms / 1000).toFixed(1)}s` : '';
        const dataStr = log.data ? ` <span class="text-gray-600">${JSON.stringify(log.data).slice(0, 100)}</span>` : '';

        return `<div class="${color}"><span class="text-gray-600">${time}</span> ${escapeHtml(log.message)}${dataStr}</div>`;
    }).join('');

    content.innerHTML = html;

    // Auto-scroll to bottom
    content.scrollTop = content.scrollHeight;

    // Update model info if available
    if (modelInfoEl && modelInfo) {
        const parts = [];
        if (modelInfo.model_used) {
            // Extract short model name
            const shortModel = modelInfo.model_used.split('/').pop()?.split(':')[0] || modelInfo.model_used;
            parts.push(shortModel);
        }
        if (modelInfo.usage?.total_tokens) {
            parts.push(`${modelInfo.usage.total_tokens} tokens`);
        }
        if (modelInfo.last_iteration_duration_ms) {
            parts.push(`${(modelInfo.last_iteration_duration_ms / 1000).toFixed(1)}s`);
        }
        modelInfoEl.textContent = parts.join(' | ');
    }
}

// Helper to escape HTML
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showJobProgress(job) {
    const container = document.getElementById('job-progress-container');
    if (!container) return;

    container.classList.remove('hidden');
    state.jobStartTime = Date.now();

    // Update UI based on job type
    const isAgent = job.job_type === 'agent';
    document.getElementById('job-progress-bar-container')?.classList.toggle('hidden', !isAgent);

    updateJobProgressUI(job);

    // Start elapsed time counter
    if (state.jobElapsedInterval) clearInterval(state.jobElapsedInterval);
    state.jobElapsedInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.jobStartTime) / 1000);
        const elapsedEl = document.getElementById('job-elapsed-time');
        if (elapsedEl) {
            if (elapsed < 60) {
                elapsedEl.textContent = `Elapsed: ${elapsed}s`;
            } else {
                elapsedEl.textContent = `Elapsed: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
            }
        }
    }, 1000);
}

function updateJobProgressUI(job) {
    const statusText = document.getElementById('job-status-text');
    const statusIndicator = document.getElementById('job-status-indicator');
    const iterationCount = document.getElementById('job-iteration-count');
    const progressBar = document.getElementById('job-progress-bar');

    if (statusText) {
        const statusMap = {
            'pending': 'Queued...',
            'processing': job.job_type === 'agent' ? 'Agent working...' : 'Generating...',
            'completed': 'Complete!',
            'failed': 'Failed',
            'cancelled': 'Cancelled'
        };
        statusText.textContent = statusMap[job.status] || job.status;
    }

    if (statusIndicator) {
        const colorMap = {
            'pending': 'bg-yellow-500',
            'processing': 'bg-blue-500 animate-pulse',
            'completed': 'bg-green-500',
            'failed': 'bg-red-500',
            'cancelled': 'bg-gray-500'
        };
        statusIndicator.className = `w-2 h-2 rounded-full ${colorMap[job.status] || 'bg-gray-500'}`;
    }

    if (job.job_type === 'agent' && job.current_iteration !== undefined) {
        const maxIter = job.max_iterations || 10;
        if (iterationCount) {
            iterationCount.textContent = `${job.current_iteration}/${maxIter}`;
        }
        if (progressBar) {
            progressBar.style.width = `${(job.current_iteration / maxIter) * 100}%`;
        }
    }
}

function hideJobProgress() {
    const container = document.getElementById('job-progress-container');
    if (container) container.classList.add('hidden');

    if (state.jobElapsedInterval) {
        clearInterval(state.jobElapsedInterval);
        state.jobElapsedInterval = null;
    }
}

async function handleCancelJob() {
    if (!state.currentJob) return;

    try {
        await cancelJob(state.currentJob.id);
        showToast('Job cancelled');
        hideJobProgress();
        state.currentJob = null;
    } catch (error) {
        showToast('Failed to cancel job: ' + error.message);
    }
}

function setupJobEventListeners() {
    // Listen for job events
    events.addEventListener('job-submitted', (e) => {
        devLog('Job submitted event:', e.detail);
        showJobProgress(e.detail);
    });

    events.addEventListener('job-cancelled', () => {
        hideJobProgress();
    });

    events.addEventListener('session-expiring', (e) => {
        const warning = document.getElementById('job-session-warning');
        const timeEl = document.getElementById('session-time-remaining');
        if (warning && timeEl) {
            warning.classList.remove('hidden');
            timeEl.textContent = formatTimeRemaining(e.detail.remaining);
        }
    });

    events.addEventListener('session-expired', () => {
        showToast('Session expired. Please unlock to continue.');
        hideJobProgress();
    });

    events.addEventListener('session-unlocked', () => {
        const warning = document.getElementById('job-session-warning');
        if (warning) warning.classList.add('hidden');
        devLog('Session unlocked');

        // Retry pending prompt if there was one
        if (state.pendingPrompt) {
            devLog('Retrying pending prompt after session unlock');
            handleSend(true);
        }
    });

    // Handle early job failures (detected by fallback timer before Realtime catches it)
    events.addEventListener('job-failed-early', (e) => {
        const { jobId, error, logs } = e.detail;
        devError('Job failed early:', jobId, error);

        // Update logs if available
        if (logs) {
            updateJobLogs(logs);
        }

        // Clean up job state
        hideJobProgress();
        if (state.currentJob?.id === jobId) {
            state.currentJob = null;
        }
        clearLastJobProjectId();

        // Show error to user
        showToast('Job failed: ' + error);
    });
}

async function checkForCompletedJobsOnLoad() {
    if (!state.projectId || !state.user) return;

    try {
        const completedJobs = await checkCompletedJobs(state.projectId);

        if (completedJobs.length > 0) {
            const latestJob = completedJobs[0];
            devLog('Found completed job from background:', latestJob.id);

            // Reload the project to get the new version
            await loadProject(state.projectId, true);

            const jobCount = completedJobs.length;
            showToast(`${jobCount} background job${jobCount > 1 ? 's' : ''} completed while you were away!`);
        }
    } catch (error) {
        devError('Error checking completed jobs:', error);
    }
}

async function checkForPendingJobs() {
    if (!state.user) return;

    try {
        const pendingJobs = await getPendingJobs();

        if (pendingJobs.length > 0) {
            // Subscribe to the most recent job
            const latestJob = pendingJobs[0];
            state.currentJob = latestJob;

            // If the job is for a different project, switch to that project
            if (latestJob.project_id && latestJob.project_id !== state.projectId) {
                devLog('Active job found for different project, switching to:', latestJob.project_id);
                await loadProject(latestJob.project_id);
                showToast('Switched to project with active job');
            }

            showJobProgress(latestJob);

            // Setup fallback timer for pending job
            const fallbackCleanup = setupJobFallback(latestJob.id, null);

            // Subscribe to updates
            state.jobSubscription = subscribeToJob(latestJob.id, {
                onStatusChange: (status) => {
                    if (state.currentJob) {
                        state.currentJob.status = status;
                        updateJobProgressUI(state.currentJob);
                    }
                    // Notify fallback of status change
                    fallbackCleanup(status);
                },
                onProgress: (progress) => {
                    if (state.currentJob) {
                        state.currentJob.current_iteration = progress.iteration;
                        state.currentJob.max_iterations = progress.maxIterations;
                        updateJobProgressUI(state.currentJob);
                    }
                },
                onLog: (logs, modelInfo) => {
                    updateJobLogs(logs, modelInfo);
                },
                onComplete: async (result) => {
                    devLog('Background job completed:', result);
                    hideJobProgress();
                    state.currentJob = null;
                    clearLastJobProjectId(); // Clear the remembered project

                    // Reload project to show new version
                    if (state.projectId) {
                        await loadProject(state.projectId, true);
                    }

                    // Notify project list to update indicators
                    events.dispatchEvent(new CustomEvent('job-completed', { detail: result }));

                    const modeLabel = result.iterations > 1
                        ? `Agent completed in ${result.iterations} iterations`
                        : 'Generation complete';
                    showToast(modeLabel);
                },
                onError: (error, logs) => {
                    devError('Background job failed:', error);
                    // Keep logs visible on error for debugging
                    if (logs) updateJobLogs(logs);
                    hideJobProgress();
                    state.currentJob = null;
                    clearLastJobProjectId(); // Clear the remembered project

                    // Notify project list to update indicators
                    events.dispatchEvent(new CustomEvent('job-failed', { detail: error }));

                    showToast('Job failed: ' + error.message);
                }
            });

            showToast(`Resuming ${pendingJobs.length > 1 ? pendingJobs.length + ' jobs' : 'job'} in progress...`);
        }
    } catch (error) {
        devError('Error checking pending jobs:', error);
    }
}

/**
 * Check if background jobs should be used for generation
 * (only returns true if fully ready - key configured AND session unlocked)
 */
function shouldUseBackgroundJobs() {
    return state.settings.useBackgroundJobs &&
           hasServerKey() &&
           state.sessionUnlocked;
}

/**
 * Check if user has server key configured (regardless of session state)
 * Used to determine which unlock flow to use
 */
function hasServerKeyConfigured() {
    return state.settings.hasServerKey && hasServerKey();
}

/**
 * Auto-queue the current immediate generation when user leaves page
 * Called by visibilitychange handler when page becomes hidden during immediate mode
 */
async function autoQueueCurrentGeneration() {
    const ctx = state.immediateGeneration;
    if (!ctx) {
        devLog('No immediate generation context to queue');
        return;
    }

    // Only queue if we have server key capability
    if (!hasServerKeyConfigured() || !state.sessionUnlocked) {
        devLog('Cannot auto-queue: server key not configured or session not unlocked');
        return;
    }

    devLog('Auto-queueing generation:', ctx.prompt.slice(0, 50) + '...');

    try {
        // Submit the job to background queue
        const job = await submitJob(ctx.projectId, ctx.prompt, ctx.files, {
            isAgent: ctx.isAgent,
            maxIterations: 10
        });

        showToast('Job auto-queued - will continue in background');
        devLog('Auto-queued job:', job.id);

        // Clear the immediate generation context
        state.immediateGeneration = null;

        // Setup fallback timer for auto-queued job
        const fallbackCleanup = setupJobFallback(job.id, null);

        // Set up subscription for the auto-queued job
        state.jobSubscription = subscribeToJob(job.id, {
            onStatusChange: (status) => {
                fallbackCleanup(status);
            },
            onLog: (logs, modelInfo) => {
                updateJobLogs(logs, modelInfo);
            },
            onComplete: async (result) => {
                devLog('Auto-queued job completed:', result);
                await loadProject(ctx.projectId, true);
            },
            onError: (error, logs) => {
                devError('Auto-queued job failed:', error);
                if (logs) updateJobLogs(logs);
            }
        });

    } catch (error) {
        devError('Failed to auto-queue generation:', error);
        // Don't clear context - maybe user comes back and it can retry
    }
}

async function handleSend(isRetry = false) {
    const input = document.getElementById('prompt-input');
    const prompt = isRetry ? state.pendingPrompt : input.value.trim();

    if (!prompt) return;

    // Auth Check
    if (!state.user) {
        showToast('Please sign in with GitHub first');
        return;
    }

    // Check which key system to use
    const useServerKey = hasServerKeyConfigured();

    if (useServerKey) {
        // Server key mode - check session is unlocked
        if (!state.sessionUnlocked) {
            state.pendingPrompt = prompt;
            const unlockTitle = state.settings.useBackgroundJobs
                ? "Unlock Session for Background Jobs"
                : "Unlock Session to Generate";
            startPinFlow('unlock-session', unlockTitle);
            return;
        }
    } else {
        // Client-side key mode - check API key is unlocked
        if (!security.isUnlocked()) {
            state.pendingPrompt = prompt;
            startPinFlow('unlock', "Unlock API Key to Generate");
            return;
        }
    }

    if (state.isGenerating || state.currentJob) {
        showToast('Generation already in progress');
        return;
    }

    const useAgent = isAgentModeEnabled();

    // Create Project if needed (before submitting job)
    if (!state.projectId) {
        const name = prompt.split(' ').slice(0, 4).join(' ') + (prompt.split(' ').length > 4 ? '...' : '');
        devLog('Creating new project:', name);
        try {
            const project = await createProject(name);
            state.projectId = project.id;
            state.projectName = project.name;
            state.versions = [];
            state.currentVersionIndex = -1;

            const url = new URL(window.location);
            url.searchParams.set('project', project.id);
            window.history.replaceState({}, '', url);

            document.getElementById('current-project-name').textContent = project.name;
        } catch (error) {
            showToast('Failed to create project: ' + error.message);
            return;
        }
    }

    const currentFiles = getCurrentFiles();

    // Background job mode - use if server key is configured and setting is enabled
    // Requires cron scheduler (GitHub Actions workflow is set up for this)
    const useBackgroundMode = useServerKey && state.settings.useBackgroundJobs;

    if (useBackgroundMode) {
        devLog('Using BACKGROUND JOB mode');

        try {
            const job = await submitJob(state.projectId, prompt, currentFiles, {
                isAgent: useAgent,
                maxIterations: 10
            });

            // Clear input
            input.value = '';
            input.style.height = 'auto';
            state.pendingPrompt = null;

            // Setup fallback timer (triggers if job stays pending > 10s)
            const fallbackCleanup = setupJobFallback(job.id, (status) => {
                devLog('Fallback received status:', status);
            });

            // Subscribe to job updates
            state.jobSubscription = subscribeToJob(job.id, {
                onStatusChange: (status) => {
                    job.status = status;
                    updateJobProgressUI(job);
                    // Notify fallback of status change (clears timer if processing started)
                    fallbackCleanup(status);
                },
                onProgress: (progress) => {
                    job.current_iteration = progress.iteration;
                    job.max_iterations = progress.maxIterations;
                    updateJobProgressUI(job);
                },
                onLog: (logs, modelInfo) => {
                    updateJobLogs(logs, modelInfo);
                },
                onComplete: async (result) => {
                    devLog('Background job completed:', result);
                    hideJobProgress();
                    state.currentJob = null;
                    clearLastJobProjectId(); // Clear the remembered project
                    if (state.jobSubscription) {
                        state.jobSubscription();
                        state.jobSubscription = null;
                    }

                    // Reload project to show new version
                    await loadProject(state.projectId, true);

                    // Notify project list to update indicators
                    events.dispatchEvent(new CustomEvent('job-completed', { detail: result }));

                    const modeLabel = result.iterations > 1
                        ? `Agent completed in ${result.iterations} iterations`
                        : 'Generation complete';
                    showToast(modeLabel);
                },
                onError: (error, logs) => {
                    devError('Background job failed:', error);
                    // Keep logs visible on error for debugging
                    if (logs) updateJobLogs(logs);
                    hideJobProgress();
                    state.currentJob = null;
                    clearLastJobProjectId(); // Clear the remembered project
                    if (state.jobSubscription) {
                        state.jobSubscription();
                        state.jobSubscription = null;
                    }

                    // Notify project list to update indicators
                    events.dispatchEvent(new CustomEvent('job-failed', { detail: error }));

                    showToast('Job failed: ' + error.message);
                }
            });

            showToast(useAgent ? 'Agent job submitted - runs in background!' : 'Job submitted - runs in background!');

        } catch (error) {
            devError('Failed to submit job:', error);
            showToast('Failed to submit job: ' + error.message);
        }

        return;
    }

    // Synchronous/Immediate mode - process on-device
    // If server key is configured but toggle is OFF, this enables auto-queue fallback
    const isImmediateMode = useServerKey && !state.settings.useBackgroundJobs;
    devLog(isImmediateMode ? 'Using IMMEDIATE mode (with auto-queue fallback)' : 'Using SYNCHRONOUS mode');

    const loadingText = state.projectId
        ? (useAgent ? "Agent refining project..." : "Refining project...")
        : (useAgent ? "Agent creating project..." : "Architecting new project...");

    setLoading(true, loadingText);

    // Track immediate generation context for auto-queue fallback
    if (isImmediateMode) {
        state.immediateGeneration = {
            projectId: state.projectId,
            prompt,
            files: currentFiles,
            isAgent: useAgent,
            startedAt: Date.now()
        };
        devLog('Immediate mode context set - will auto-queue if user leaves');
    }

    try {
        if (!state.projectId) {
            throw new Error('Failed to initialize project');
        }

        // Choose between Agent Mode and Normal Mode
        let result;
        if (useAgent) {
            devLog('Using AGENT MODE');
            result = await runAgent(prompt, currentFiles);
        } else {
            devLog('Using NORMAL MODE');
            result = await generateProject(prompt, currentFiles);
        }

        // Validate result
        if (!result) {
            throw new Error('No response received from AI');
        }

        if (!result.files || !Array.isArray(result.files)) {
            throw new Error('Invalid response: missing files');
        }

        if (result.files.length === 0) {
            throw new Error('AI returned no files - try rephrasing your request');
        }

        // Validate each file has required properties
        for (const file of result.files) {
            if (!file.path) {
                devLog('Warning: file missing path, skipping', file);
                continue;
            }
            if (typeof file.content !== 'string') {
                devLog('Warning: file missing content', file.path);
                file.content = '';
            }
        }

        // Filter out invalid files
        result.files = result.files.filter(f => f.path && typeof f.content === 'string');

        if (result.files.length === 0) {
            throw new Error('No valid files in AI response');
        }

        state.pendingPrompt = null;

        // Final state verification before saving
        if (!state.projectId) {
            throw new Error('Project ID lost during generation - please try again');
        }

        // Create version (and auto-commit via projects.js) only after agent completes
        devLog('Creating version with', result.files.length, 'files for project:', state.projectId);

        try {
            await createVersion(state.projectId, {
                prompt: prompt,
                files: result.files,
                description: result.description || "Updated project",
            });
        } catch (versionError) {
            devError('Failed to create version:', versionError);
            // Still show the preview even if saving failed
            const { renderProject } = await import('./renderer.js');
            renderProject(result.files);
            document.getElementById('welcome-screen')?.classList.add('hidden');
            showToast('Generated but failed to save: ' + versionError.message);
            throw versionError;
        }

        // Clear input after successful save
        input.value = '';
        input.style.height = 'auto';

        // Final UI verification - ensure preview is showing
        document.getElementById('welcome-screen')?.classList.add('hidden');
        document.getElementById('project-loader')?.classList.add('hidden');

        const modeLabel = useAgent ? `Agent completed in ${result.iterations || 1} iteration(s)` : 'Version generated';
        showToast(modeLabel);

        // Clear immediate generation context on success
        state.immediateGeneration = null;

        devLog('Generation complete - project:', state.projectId, 'versions:', state.versions.length);

    } catch (error) {
        console.error('Generation error:', error);
        devLog('Full error:', error);

        // Check if this was an Agent Mode failure that could benefit from Simple Mode
        const wasAgentMode = useAgent;
        const isAgentToolError = error.message?.includes('Agent Mode') ||
                                  error.message?.includes('no files') ||
                                  error.message?.includes('empty response');

        if (wasAgentMode && isAgentToolError) {
            // Offer to retry in Simple Mode
            const retrySimple = confirm(
                `Agent Mode failed: ${error.message?.split('\n')[0] || 'Unknown error'}\n\n` +
                `Would you like to retry in Simple Mode?\n\n` +
                `(Simple Mode works with all models and is faster)`
            );

            if (retrySimple) {
                devLog('Retrying in Simple Mode after Agent failure');
                setAgentMode(false);
                updateAgentModeUI();
                // Retry the generation
                setLoading(true, "Retrying in Simple Mode...");
                try {
                    const currentFiles = getCurrentFiles();
                    const result = await generateProject(prompt, currentFiles);

                    if (result?.files?.length > 0) {
                        result.files = result.files.filter(f => f.path && typeof f.content === 'string');

                        if (result.files.length > 0) {
                            await createVersion(state.projectId, {
                                prompt: prompt,
                                files: result.files,
                                description: result.description || "Updated project",
                            });

                            input.value = '';
                            input.style.height = 'auto';
                            showToast('Generated in Simple Mode');
                            return;
                        }
                    }
                    throw new Error('Simple Mode also failed');
                } catch (retryError) {
                    showToast("Retry failed: " + (retryError.message || "Please try again."));
                }
            } else {
                showToast("Try switching to Simple Mode or a different model");
            }
        } else {
            showToast("Generation failed: " + (error.message?.split('\n')[0] || "Please try again."));
        }
    } finally {
        setLoading(false);
        thinking.hide(); // Ensure thinking UI is hidden
        // Clear immediate generation context - generation is done (success or fail)
        state.immediateGeneration = null;
    }
}

// --- Model Selector ---
function injectModelSelector() {
    const dropdown = document.createElement('div');
    dropdown.id = 'model-dropdown';
    dropdown.className = 'fixed z-50 hidden';
    dropdown.innerHTML = `
        <div class="bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-xl shadow-2xl w-72 max-h-96 overflow-hidden flex flex-col">
            <!-- Mode Toggle at Top -->
            <div class="p-2 border-b border-gray-700/50">
                <div class="flex items-center justify-between mb-2 px-1">
                    <span class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Generation Mode</span>
                </div>
                <div id="mode-toggle-container" class="flex rounded-lg bg-gray-800/50 p-0.5 border border-gray-700/50">
                    <button type="button" id="btn-simple-mode" class="flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2">
                        <i class="fa-solid fa-bolt text-[10px]"></i>
                        <span>Simple</span>
                    </button>
                    <button type="button" id="btn-agent-mode-toggle" class="flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2">
                        <i class="fa-solid fa-robot text-[10px]"></i>
                        <span>Agent</span>
                    </button>
                </div>
                <p id="mode-description" class="text-[10px] text-gray-500 mt-1.5 px-1 text-center"></p>
            </div>
            <!-- Model Selection -->
            <div class="p-2 border-b border-gray-700/50">
                <div class="flex items-center justify-between mb-2 px-2">
                    <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Select Model</span>
                    <span id="credits-badge" class="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700"></span>
                </div>
                <input id="model-search" type="text" placeholder="Search models..." class="w-full bg-gray-800 text-gray-200 text-xs p-2 rounded-lg border border-gray-700 focus:border-blue-500 focus:outline-none placeholder-gray-500">
            </div>
            <div id="model-list" class="overflow-y-auto p-1 custom-scrollbar flex-1">
                <div class="text-gray-500 text-xs text-center py-4">Loading models...</div>
            </div>
        </div>
    `;
    document.body.appendChild(dropdown);
}

function setupModelSelector() {
    const btn = document.getElementById('btn-model-selector');
    const dropdown = document.getElementById('model-dropdown');
    const search = document.getElementById('model-search');

    let models = [];
    let isOpen = false;
    let modeHandlersSetup = false;

    // Update mode toggle UI in dropdown
    const updateModeToggleUI = () => {
        const simpleBtn = document.getElementById('btn-simple-mode');
        const agentBtn = document.getElementById('btn-agent-mode-toggle');
        const description = document.getElementById('mode-description');
        const isAgent = state.settings.agentMode;

        if (simpleBtn && agentBtn && description) {
            if (isAgent) {
                agentBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 bg-purple-600 text-white shadow-lg';
                simpleBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white hover:bg-gray-700/50';
                description.textContent = 'Multi-pass tool-calling agent (like Claude Code)';
            } else {
                simpleBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white shadow-lg';
                agentBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white hover:bg-gray-700/50';
                description.textContent = 'Single prompt → instant output (fast)';
            }
        }
        // Also update model display
        updateModelDisplay();
    };

    // Setup mode toggle handlers once
    const setupModeHandlers = () => {
        if (modeHandlersSetup) return;
        modeHandlersSetup = true;

        const simpleBtn = document.getElementById('btn-simple-mode');
        const agentBtn = document.getElementById('btn-agent-mode-toggle');

        simpleBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.settings.agentMode) {
                setAgentMode(false);
                updateModeToggleUI();
                showToast('Simple Mode: Single prompt → instant output');
            }
        });

        agentBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.settings.agentMode) {
                if (!supportsToolCalling(state.settings.openRouterModel)) {
                    showToast('Current model may not support Agent Mode - try Claude or GPT-4');
                }
                setAgentMode(true);
                updateModeToggleUI();
                showToast('Agent Mode: Multi-pass with tools');
            }
        });
    };

    btn?.addEventListener('click', async (e) => {
        e.stopPropagation();

        // Check if either key system is unlocked
        const hasAccess = security.isUnlocked() || (hasServerKeyConfigured() && state.sessionUnlocked);
        if (!hasAccess) {
            if (hasServerKeyConfigured()) {
                startPinFlow('unlock-session', "Unlock to select model");
            } else {
                startPinFlow('unlock', "Unlock to select model");
            }
            return;
        }

        isOpen = !isOpen;

        if (isOpen) {
            // Position dropdown above button
            const rect = btn.getBoundingClientRect();
            dropdown.style.left = `${Math.max(10, rect.left - 100)}px`;
            dropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;
            dropdown.classList.remove('hidden');

            // Update mode toggle state and setup handlers
            updateModeToggleUI();
            setupModeHandlers();

            // Fetch models and credits
            const list = document.getElementById('model-list');
            const badge = document.getElementById('credits-badge');
            list.innerHTML = '<div class="text-gray-500 text-xs text-center py-4"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading...</div>';

            try {
                const [fetchedModels, credits] = await Promise.all([
                    fetchModelsWithCredits(),
                    checkCredits()
                ]);

                models = fetchedModels;

                // Update credits badge
                if (credits) {
                    if (credits.isFreeTier) {
                        badge.textContent = 'Free Tier';
                        badge.className = 'text-[10px] px-2 py-0.5 rounded bg-yellow-900/30 text-yellow-400 border border-yellow-900/30';
                    } else if (credits.isUnlimited) {
                        badge.textContent = 'Unlimited';
                        badge.className = 'text-[10px] px-2 py-0.5 rounded bg-purple-900/30 text-purple-400 border border-purple-900/30';
                    } else {
                        const remaining = (credits.remaining / 100).toFixed(2);
                        badge.textContent = `$${remaining} credits`;
                        badge.className = 'text-[10px] px-2 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-900/30';
                    }
                }

                renderModelList(models);
            } catch (err) {
                list.innerHTML = '<div class="text-red-400 text-xs text-center py-4">Failed to load models</div>';
            }

            search?.focus();
        } else {
            dropdown.classList.add('hidden');
        }
    });

    // Search filter
    search?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = models.filter(m =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query)
        );
        renderModelList(filtered);
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (isOpen && !dropdown.contains(e.target) && !btn.contains(e.target)) {
            isOpen = false;
            dropdown.classList.add('hidden');
        }
    });

    // Listen for security unlock to refresh
    window.addEventListener('security-locked', () => {
        isOpen = false;
        dropdown.classList.add('hidden');
    });
}

function renderModelList(models) {
    const list = document.getElementById('model-list');
    if (!list) return;

    if (models.length === 0) {
        list.innerHTML = '<div class="text-gray-500 text-xs text-center py-4">No models found</div>';
        return;
    }

    // Sort: tool-capable models first when in Agent mode
    const isAgentMode = state.settings.agentMode;
    const sortedModels = [...models].sort((a, b) => {
        if (isAgentMode) {
            // Prioritize tool-capable models
            const aTools = a.toolSupport === 'full' ? 2 : a.toolSupport === 'partial' ? 1 : 0;
            const bTools = b.toolSupport === 'full' ? 2 : b.toolSupport === 'partial' ? 1 : 0;
            if (bTools !== aTools) return bTools - aTools;
        }
        return a.name.localeCompare(b.name);
    });

    list.innerHTML = sortedModels.map(m => {
        const isSelected = m.id === state.settings.openRouterModel;
        const toolSupport = m.toolSupport || 'none';

        // Tool support indicator
        let toolBadge = '';
        let toolTitle = '';
        if (toolSupport === 'full') {
            toolBadge = '<span class="text-[9px] px-1 py-0.5 rounded bg-purple-900/30 text-purple-400 border border-purple-900/30" title="Full Agent Mode support">🤖</span>';
            toolTitle = 'Full tool/function calling support';
        } else if (toolSupport === 'partial') {
            toolBadge = '<span class="text-[9px] px-1 py-0.5 rounded bg-yellow-900/30 text-yellow-400 border border-yellow-900/30" title="Partial Agent Mode support">⚠️</span>';
            toolTitle = 'Limited tool support - may not work perfectly in Agent mode';
        } else if (isAgentMode) {
            toolBadge = '<span class="text-[9px] px-1 py-0.5 rounded bg-gray-700/50 text-gray-500 border border-gray-600/30" title="Simple Mode only">⚡</span>';
            toolTitle = 'No tool support - Simple Mode only';
        }

        // Dim non-tool models when in Agent mode
        const dimmed = isAgentMode && toolSupport === 'none';
        const rowClass = dimmed
            ? 'opacity-50 hover:opacity-75'
            : isSelected
                ? 'bg-blue-900/30 text-blue-200'
                : 'hover:bg-gray-800 text-gray-300';

        return `
            <div class="model-item p-2 rounded-lg cursor-pointer flex justify-between items-center group transition-colors ${rowClass}"
                 data-model-id="${m.id}"
                 data-tool-support="${toolSupport}"
                 title="${toolTitle}">
                <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium truncate flex items-center gap-1.5">
                        ${m.name}
                    </div>
                    <div class="text-[10px] text-gray-500 truncate">${m.id}</div>
                </div>
                <div class="flex items-center gap-1 ml-2">
                    ${toolBadge}
                    ${m.isFree ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-900/30">FREE</span>' : ''}
                    ${isSelected ? '<i class="fa-solid fa-check text-blue-400 text-xs"></i>' : ''}
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers
    list.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
            const modelId = item.dataset.modelId;
            const toolSupport = item.dataset.toolSupport;

            // If in Agent mode and model doesn't support tools, auto-switch to Simple
            if (state.settings.agentMode && toolSupport === 'none') {
                setAgentMode(false);
                // Update the mode toggle UI
                const simpleBtn = document.getElementById('btn-simple-mode');
                const agentBtn = document.getElementById('btn-agent-mode-toggle');
                const description = document.getElementById('mode-description');
                if (simpleBtn && agentBtn && description) {
                    simpleBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white shadow-lg';
                    agentBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white hover:bg-gray-700/50';
                    description.textContent = 'Single prompt → instant output (fast)';
                }
                showToast(`Switched to Simple Mode (${item.querySelector('.text-xs').textContent} doesn't support Agent)`);
            } else if (toolSupport === 'partial') {
                showToast(`⚠️ ${item.querySelector('.text-xs').textContent} has limited Agent support`);
            } else {
                showToast(`Model: ${item.querySelector('.text-xs').textContent}`);
            }

            state.settings.openRouterModel = modelId;
            localStorage.setItem('app_settings', JSON.stringify({
                ...JSON.parse(localStorage.getItem('app_settings') || '{}'),
                openRouterModel: modelId
            }));
            updateModelDisplay();
            document.getElementById('model-dropdown').classList.add('hidden');
        });
    });
}

function updateModelDisplay() {
    const display = document.getElementById('model-display');
    const modeIcon = document.getElementById('mode-icon');
    if (!display) return;

    const modelId = state.settings.openRouterModel;
    // Show short name (no emoji, icon handles mode)
    const shortName = modelId.split('/').pop().split('-').slice(0, 2).join(' ');
    display.textContent = shortName.charAt(0).toUpperCase() + shortName.slice(1);

    // Update mode icon
    if (modeIcon) {
        if (state.settings.agentMode) {
            modeIcon.className = 'fa-solid fa-robot text-[10px] text-purple-400';
        } else {
            modeIcon.className = 'fa-solid fa-bolt text-[10px] text-blue-400';
        }
    }
}

// --- Health Indicator ---
let healthDropdownOpen = false;

function setupHealthIndicator() {
    const btn = document.getElementById('btn-health');
    if (!btn) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        healthDropdownOpen = !healthDropdownOpen;

        if (healthDropdownOpen) {
            showHealthDropdown(btn);
        } else {
            hideHealthDropdown();
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (healthDropdownOpen && !e.target.closest('#health-dropdown') && !e.target.closest('#btn-health')) {
            healthDropdownOpen = false;
            hideHealthDropdown();
        }
    });
}

function updateHealthIndicator() {
    const btn = document.getElementById('btn-health');
    const label = document.getElementById('health-label');
    if (!btn || !label) return;

    const files = getCurrentFiles();
    if (!files || files.length === 0) {
        btn.classList.add('hidden');
        btn.classList.remove('flex');
        return;
    }

    const health = analyzeProjectHealth(files);

    if (health.status === 'healthy') {
        btn.classList.add('hidden');
        btn.classList.remove('flex');
        return;
    }

    // Show the indicator
    btn.classList.remove('hidden');
    btn.classList.add('flex');

    // Update styling based on status
    const colors = getStatusColor(health.status);
    btn.className = `absolute right-28 bottom-2 h-8 px-2 rounded-lg text-xs border flex items-center gap-1.5 transition-colors cursor-pointer hover:opacity-80 ${colors}`;

    // Show total tokens or warning count
    if (health.warnings.length > 0) {
        const largestFile = health.warnings.reduce((max, f) => f.tokens > max.tokens ? f : max);
        label.textContent = `${formatTokenCount(largestFile.tokens)}+`;
        btn.title = `${health.warnings.length} file(s) need attention - click to manage`;
    }
}

function showHealthDropdown(anchorBtn) {
    // Remove existing dropdown
    hideHealthDropdown();

    const files = getCurrentFiles();
    const health = analyzeProjectHealth(files);
    const suggestions = getRefactoringSuggestions(files);

    const dropdown = document.createElement('div');
    dropdown.id = 'health-dropdown';
    dropdown.className = 'fixed z-50 bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-xl shadow-2xl w-80 max-h-96 overflow-hidden flex flex-col';

    // Position above button
    const rect = anchorBtn.getBoundingClientRect();
    dropdown.style.left = `${Math.max(10, rect.left - 150)}px`;
    dropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;

    dropdown.innerHTML = `
        <div class="p-3 border-b border-gray-700/50">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <i class="fa-solid fa-heart-pulse ${health.status === 'critical' ? 'text-red-400' : 'text-yellow-400'}"></i>
                    <span class="text-sm font-semibold text-white">Project Health</span>
                </div>
                <span class="text-xs px-2 py-0.5 rounded ${getStatusColor(health.status)}">${health.status.toUpperCase()}</span>
            </div>
            <p class="text-xs text-gray-400 mt-1">
                ${formatTokenCount(health.totalTokens)} total tokens across ${files.length} files
            </p>
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
            ${health.warnings.length === 0 ? `
                <div class="text-center text-gray-500 text-xs py-4">
                    <i class="fa-solid fa-check-circle text-green-400 text-lg mb-2"></i>
                    <p>All files are within healthy limits</p>
                </div>
            ` : health.warnings.map(file => `
                <div class="bg-gray-800/50 rounded-lg p-2 border ${file.status === 'critical' ? 'border-red-900/50' : 'border-yellow-900/50'}">
                    <div class="flex items-center justify-between mb-1">
                        <span class="text-xs font-medium text-white truncate">${file.path}</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded ${getStatusColor(file.status)}">${formatTokenCount(file.tokens)}</span>
                    </div>
                    <p class="text-[10px] text-gray-400 mb-2">${file.lines} lines - consider splitting for better maintainability</p>
                    <button class="refactor-btn w-full text-[10px] py-1.5 px-2 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors flex items-center justify-center gap-1" data-file="${file.path}">
                        <i class="fa-solid fa-code-branch"></i>
                        Refactor into smaller files
                    </button>
                </div>
            `).join('')}
        </div>
        <div class="p-2 border-t border-gray-700/50 bg-gray-800/30">
            <p class="text-[10px] text-gray-500 text-center">
                Files over 5k tokens may slow down AI responses
            </p>
        </div>
    `;

    document.body.appendChild(dropdown);

    // Add refactor button handlers
    dropdown.querySelectorAll('.refactor-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const filePath = btn.dataset.file;
            await handleRefactorFile(filePath);
            hideHealthDropdown();
            healthDropdownOpen = false;
        });
    });
}

function hideHealthDropdown() {
    const existing = document.getElementById('health-dropdown');
    if (existing) existing.remove();
}

async function handleRefactorFile(filePath) {
    const files = getCurrentFiles();
    if (!files) return;

    setLoading(true, `Refactoring ${filePath}...`);

    try {
        const result = await refactorLargeFile(files, filePath);

        if (result && result.files) {
            // Apply the refactoring as a new version
            const mergedFiles = [...files];

            for (const newFile of result.files) {
                const action = newFile.action || 'modify';
                const existingIndex = mergedFiles.findIndex(f => f.path === newFile.path);

                if (action === 'delete') {
                    if (existingIndex !== -1) {
                        mergedFiles.splice(existingIndex, 1);
                    }
                } else if (action === 'add' || existingIndex === -1) {
                    mergedFiles.push({ path: newFile.path, content: newFile.content });
                } else {
                    mergedFiles[existingIndex] = { path: newFile.path, content: newFile.content };
                }
            }

            await createVersion(state.projectId, {
                prompt: `Refactored ${filePath} into smaller files`,
                files: mergedFiles,
                description: result.description || `Refactored ${filePath}`,
            });

            showToast(`Refactored ${filePath} successfully`);
            updateHealthIndicator();
        }
    } catch (error) {
        devLog('Refactoring failed:', error);
        showToast(`Refactoring failed: ${error.message}`);
    } finally {
        setLoading(false);
    }
}

// --- Agent Mode Toggle ---
function setupAgentModeToggle() {
    // Load saved setting
    const saved = JSON.parse(localStorage.getItem('app_settings') || '{}');
    if (typeof saved.agentMode === 'boolean') {
        state.settings.agentMode = saved.agentMode;
    }

    // Update model display to reflect current mode
    updateModelDisplay();
}

function toggleAgentMode() {
    const newState = !state.settings.agentMode;

    // Check if model supports tool calling for agent mode
    if (newState && !supportsToolCalling(state.settings.openRouterModel)) {
        showToast('Current model may not support Agent Mode - try Claude or GPT-4');
    }

    setAgentMode(newState);
    updateAgentModeUI();
    updateModelDisplay();
    showToast(newState ? 'Agent Mode: Multi-pass with tools' : 'Simple Mode: Single output');
}

function updateAgentModeUI() {
    // Update the mode toggle in the dropdown if visible
    const simpleBtn = document.getElementById('btn-simple-mode');
    const agentBtn = document.getElementById('btn-agent-mode-toggle');
    const description = document.getElementById('mode-description');
    const isAgent = state.settings.agentMode;

    if (simpleBtn && agentBtn && description) {
        if (isAgent) {
            agentBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 bg-purple-600 text-white shadow-lg';
            simpleBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white hover:bg-gray-700/50';
            description.textContent = 'Multi-pass tool-calling agent (like Claude Code)';
        } else {
            simpleBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white shadow-lg';
            agentBtn.className = 'flex-1 py-2 px-3 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 text-gray-400 hover:text-white hover:bg-gray-700/50';
            description.textContent = 'Single prompt → instant output (fast)';
        }
    }

    // Update model display
    updateModelDisplay();
}

// Boot
init();
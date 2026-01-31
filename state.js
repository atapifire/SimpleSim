import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Supabase Configuration
const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91dnJlY2xsa3F0d2J0cnd5aGd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MzQ1MjgsImV4cCI6MjA4NTIxMDUyOH0.q7IiJXV6RUJ_NHy6coK1pZmM-bap2sxlfrLmBSxhp4s';

// Initialize Supabase client
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const state = {
    // Auth state
    user: null,
    profile: null,
    session: null, // Store full session with access_token
    isAuthLoading: true,

    // Project state
    projectId: new URLSearchParams(window.location.search).get('project'),
    projectName: "New Project",
    versions: [],
    projects: [],
    currentVersionIndex: -1,
    isGenerating: false,
    immediateGeneration: null, // Tracks immediate mode generation context for auto-queue fallback
    historyOpen: false,
    projectMenuOpen: false,
    versionUnsubscribe: null,

    // Settings State
    settings: {
        isOpen: false,
        useOpenRouter: true, // Default to OpenRouter since we removed websim.chat
        openRouterModel: "anthropic/claude-3.5-sonnet",
        hasKey: false,
        hasServerKey: false, // Server-side encrypted key with sharding
        useHuggingFace: false,
        hasHfKey: false,
        hfImageModel: "stabilityai/stable-diffusion-xl-base-1.0",
        hfTtsModel: "facebook/mms-tts-eng",
        githubAutoCreate: false,
        githubAutoSync: false,
        agentMode: false, // Toggle between Agent Mode (multi-pass) and Normal Mode (single output)
        trainingOptOut: true, // COPPA/GDPR: Opt out of data training by default
        useBackgroundJobs: false, // Background jobs require cron setup - default to synchronous
    },

    // Background Job State
    currentJob: null, // Currently running/pending job
    jobSubscription: null, // Realtime subscription cleanup function
    sessionUnlocked: false, // Whether user has unlocked their session
    sessionExpiresAt: null, // When the session expires
    serverApiKey: null, // API key from unlocked session (memory only, not persisted)

    // Temp state for PIN flows
    pinFlow: null,
    pendingPrompt: null,
};

/**
 * In-Memory Project Cache
 * Caches project data to avoid repeated fetches from Supabase/GitHub
 * TTL: 5 minutes for project list, versions cached until project changes
 */
class ProjectCache {
    constructor() {
        this.projectsCache = null;
        this.projectsCacheTime = 0;
        this.versionsCache = new Map(); // projectId -> { versions, timestamp }
        this.filesCache = new Map(); // projectId -> { files, timestamp }
        this.PROJECTS_TTL = 5 * 60 * 1000; // 5 minutes
        this.VERSIONS_TTL = 10 * 60 * 1000; // 10 minutes
    }

    // Project list caching
    setProjects(projects) {
        this.projectsCache = projects;
        this.projectsCacheTime = Date.now();
    }

    getProjects() {
        if (this.projectsCache && (Date.now() - this.projectsCacheTime) < this.PROJECTS_TTL) {
            return this.projectsCache;
        }
        return null;
    }

    invalidateProjects() {
        this.projectsCache = null;
        this.projectsCacheTime = 0;
    }

    // Version caching per project
    setVersions(projectId, versions) {
        this.versionsCache.set(projectId, {
            versions: JSON.parse(JSON.stringify(versions)), // Deep clone
            timestamp: Date.now()
        });
    }

    getVersions(projectId) {
        const cached = this.versionsCache.get(projectId);
        if (cached && (Date.now() - cached.timestamp) < this.VERSIONS_TTL) {
            return JSON.parse(JSON.stringify(cached.versions)); // Return clone
        }
        return null;
    }

    invalidateVersions(projectId) {
        this.versionsCache.delete(projectId);
    }

    // Current files caching (for quick access)
    setCurrentFiles(projectId, files) {
        this.filesCache.set(projectId, {
            files: JSON.parse(JSON.stringify(files)),
            timestamp: Date.now()
        });
    }

    getCurrentFiles(projectId) {
        const cached = this.filesCache.get(projectId);
        if (cached) {
            return JSON.parse(JSON.stringify(cached.files));
        }
        return null;
    }

    // Add new version to cache without full invalidation
    addVersionToCache(projectId, version) {
        const cached = this.versionsCache.get(projectId);
        if (cached) {
            cached.versions.push(JSON.parse(JSON.stringify(version)));
            cached.timestamp = Date.now();
        }
        // Also update files cache
        if (version.files) {
            this.setCurrentFiles(projectId, version.files);
        }
    }

    // Clear all caches (on logout, etc.)
    clearAll() {
        this.projectsCache = null;
        this.projectsCacheTime = 0;
        this.versionsCache.clear();
        this.filesCache.clear();
    }
}

// Export singleton cache instance
export const projectCache = new ProjectCache();

// Event Bus for decoupled communication
export const events = new EventTarget();

// Auth helpers
export async function signInWithGitHub() {
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
            scopes: 'repo user:email',
            redirectTo: window.location.origin + window.location.pathname
        }
    });
    if (error) throw error;
    return data;
}

export async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    state.user = null;
    state.session = null; // Clear session token on logout
    state.profile = null;
    state.sessionUnlocked = false; // Clear server key session state
    state.serverApiKey = null;
    state.sessionExpiresAt = null;
    events.dispatchEvent(new CustomEvent('auth-changed'));
}

export async function initAuth() {
    state.isAuthLoading = true;

    // Check current session
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
        state.user = session.user;
        state.session = session; // Store full session for access_token
        // Load profile and save GitHub token if available
        await loadAndUpdateProfile(session);
    }

    state.isAuthLoading = false;
    events.dispatchEvent(new CustomEvent('auth-changed'));

    // Listen for auth changes
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('[AUTH]', event, session?.user?.id);

        if (session?.user) {
            state.user = session.user;
            state.session = session; // Store full session for access_token
            await loadAndUpdateProfile(session);
        } else {
            state.user = null;
            state.session = null;
            state.profile = null;
        }
        events.dispatchEvent(new CustomEvent('auth-changed'));
    });
}

// Helper to load profile and save GitHub token
async function loadAndUpdateProfile(session) {
    const userId = session.user.id;

    // Load current profile
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

    if (error) {
        console.error('[AUTH] Failed to load profile:', error);
        state.profile = null;
        return;
    }

    state.profile = profile;

    // If we have a provider token from GitHub OAuth, save it to the profile
    // This token is needed for GitHub API operations (create repo, commit)
    const providerToken = session.provider_token;

    if (providerToken && providerToken !== profile.github_access_token) {
        console.log('[AUTH] Saving GitHub access token to profile');

        const { error: updateError } = await supabase
            .from('profiles')
            .update({ github_access_token: providerToken })
            .eq('id', userId);

        if (updateError) {
            console.error('[AUTH] Failed to save GitHub token:', updateError);
        } else {
            state.profile.github_access_token = providerToken;
            console.log('[AUTH] GitHub token saved successfully');
        }
    }
}
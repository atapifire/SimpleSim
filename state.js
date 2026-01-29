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
    isAuthLoading: true,

    // Project state
    projectId: new URLSearchParams(window.location.search).get('project'),
    projectName: "New Project",
    versions: [],
    projects: [],
    currentVersionIndex: -1,
    isGenerating: false,
    historyOpen: false,
    projectMenuOpen: false,
    versionUnsubscribe: null,

    // Settings State
    settings: {
        isOpen: false,
        useOpenRouter: true, // Default to OpenRouter since we removed websim.chat
        openRouterModel: "anthropic/claude-3.5-sonnet",
        hasKey: false,
        useHuggingFace: false,
        hasHfKey: false,
        hfImageModel: "stabilityai/stable-diffusion-xl-base-1.0",
        hfTtsModel: "facebook/mms-tts-eng",
        githubAutoCreate: false,
        githubAutoSync: false,
    },

    // Temp state for PIN flows
    pinFlow: null,
    pendingPrompt: null,
};

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
    state.profile = null;
    events.dispatchEvent(new CustomEvent('auth-changed'));
}

export async function initAuth() {
    state.isAuthLoading = true;

    // Check current session
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
        state.user = session.user;
        // Load profile
        const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();
        state.profile = profile;
    }

    state.isAuthLoading = false;
    events.dispatchEvent(new CustomEvent('auth-changed'));

    // Listen for auth changes
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (session?.user) {
            state.user = session.user;
            const { data: profile } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', session.user.id)
                .single();
            state.profile = profile;
        } else {
            state.user = null;
            state.profile = null;
        }
        events.dispatchEvent(new CustomEvent('auth-changed'));
    });
}
/**
 * Supabase Client Configuration
 *
 * This replaces the WebsimSocket from the original implementation.
 * All database operations now go through Supabase.
 */

import { createClient } from '@supabase/supabase-js';

// These will be replaced with actual values from environment
// For local dev, create a .env file with these values
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
    }
});

/**
 * Get the current authenticated user
 */
export async function getCurrentUser() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) {
        console.error('Error getting user:', error);
        return null;
    }
    return user;
}

/**
 * Get the current user's profile (includes GitHub info)
 */
export async function getCurrentProfile() {
    const user = await getCurrentUser();
    if (!user) return null;

    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

    if (error) {
        console.error('Error getting profile:', error);
        return null;
    }
    return data;
}

/**
 * Sign in with GitHub OAuth
 */
export async function signInWithGitHub() {
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
            scopes: 'repo user:email',
            redirectTo: window.location.origin
        }
    });

    if (error) {
        console.error('Error signing in:', error);
        throw error;
    }
    return data;
}

/**
 * Sign out the current user
 */
export async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) {
        console.error('Error signing out:', error);
        throw error;
    }
}

/**
 * Subscribe to auth state changes
 */
export function onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}

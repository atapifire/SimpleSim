/**
 * GitHub Integration Module
 * Handles repository creation and commits from the frontend
 */

import { state, supabase } from './state.js';
import { showToast } from './utils.js';

/**
 * Create a GitHub repository for a project
 * @param {string} projectId - The project ID
 * @param {string} name - The repository name
 * @returns {Promise<{full_name: string, html_url: string} | null>}
 */
export async function createGitHubRepo(projectId, name) {
    const session = await supabase.auth.getSession();
    const accessToken = session.data.session?.access_token;

    if (!accessToken) {
        throw new Error('Not authenticated');
    }

    const response = await fetch('/api/github/create-repo', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ projectId, name })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Failed to create repository');
    }

    return data;
}

/**
 * Commit files to a project's GitHub repository
 * @param {string} projectId - The project ID
 * @param {Array<{path: string, content: string}>} files - Files to commit
 * @param {string} message - Commit message
 * @returns {Promise<{sha: string, html_url: string} | null>}
 */
export async function commitToGitHub(projectId, files, message) {
    const session = await supabase.auth.getSession();
    const accessToken = session.data.session?.access_token;

    if (!accessToken) {
        throw new Error('Not authenticated');
    }

    const response = await fetch('/api/github/commit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({ projectId, files, message })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Failed to commit');
    }

    return data;
}

/**
 * Convert SimpleSim file format to GitHub-compatible format
 * @param {Object} files - SimpleSim files object
 * @returns {Array<{path: string, content: string}>}
 */
export function convertFilesForGitHub(files) {
    const result = [];

    // Main HTML
    if (files.html) {
        result.push({ path: 'index.html', content: files.html });
    }

    // CSS
    if (files.css) {
        result.push({ path: 'styles.css', content: files.css });
    }

    // JavaScript
    if (files.js) {
        result.push({ path: 'script.js', content: files.js });
    }

    // Any additional files
    if (files.additional && typeof files.additional === 'object') {
        Object.entries(files.additional).forEach(([filename, content]) => {
            result.push({ path: filename, content });
        });
    }

    return result;
}

/**
 * Auto-create repo for a new project if enabled in settings
 * @param {string} projectId - The project ID
 * @param {string} projectName - The project name
 */
export async function autoCreateRepoIfEnabled(projectId, projectName) {
    const autoCreate = localStorage.getItem('github_auto_create') === 'true';

    if (!autoCreate) return null;

    try {
        const result = await createGitHubRepo(projectId, projectName);
        showToast(`GitHub repo created: ${result.full_name}`);
        return result;
    } catch (error) {
        console.error('Auto-create repo failed:', error);
        // Don't show error toast - it's optional
        return null;
    }
}

/**
 * Auto-commit to GitHub after version creation if repo exists
 * @param {string} projectId - The project ID
 * @param {Object} files - The files to commit
 * @param {string} prompt - The prompt used for the commit message
 */
export async function autoCommitIfLinked(projectId, files, prompt) {
    const autoSync = localStorage.getItem('github_auto_sync') === 'true';

    if (!autoSync) return null;

    // Check if project has a GitHub repo
    const { data: project } = await supabase
        .from('projects')
        .select('github_repo')
        .eq('id', projectId)
        .single();

    if (!project?.github_repo) return null;

    try {
        const githubFiles = convertFilesForGitHub(files);
        const message = `Update: ${prompt.slice(0, 72)}${prompt.length > 72 ? '...' : ''}`;
        const result = await commitToGitHub(projectId, githubFiles, message);
        showToast('Synced to GitHub');
        return result;
    } catch (error) {
        console.error('Auto-commit failed:', error);
        return null;
    }
}

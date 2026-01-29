/**
 * GitHub Integration Module
 * Handles repository creation and commits from the frontend
 */

import { state, supabase } from './state.js';
import { showToast } from './utils.js';
import { devLog, devError } from './thinking.js';

/**
 * Create a GitHub repository for a project
 */
export async function createGitHubRepo(projectId, name) {
    devLog('Creating GitHub repo for project:', projectId, name);

    const session = await supabase.auth.getSession();
    const accessToken = session.data.session?.access_token;

    if (!accessToken) {
        devError('No access token for GitHub repo creation');
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
        devError('GitHub repo creation failed:', data);
        throw new Error(data.error || 'Failed to create repository');
    }

    devLog('GitHub repo created:', data);
    return data;
}

/**
 * Commit files to a project's GitHub repository
 */
export async function commitToGitHub(projectId, files, message) {
    devLog('Committing to GitHub:', projectId, files.length, 'files');

    const session = await supabase.auth.getSession();
    const accessToken = session.data.session?.access_token;

    if (!accessToken) {
        devError('No access token for GitHub commit');
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
        devError('GitHub commit failed:', data);
        throw new Error(data.error || 'Failed to commit');
    }

    devLog('GitHub commit successful:', data);
    return data;
}

/**
 * Convert SimpleSim file format to GitHub-compatible format
 * Handles both array format [{path, content}] and object format {html, css, js}
 */
export function convertFilesForGitHub(files) {
    devLog('Converting files for GitHub:', files);

    // If it's already an array of {path, content}, return as-is
    if (Array.isArray(files)) {
        return files.map(f => ({
            path: f.path,
            content: f.content
        }));
    }

    // Legacy object format {html, css, js}
    const result = [];

    if (files.html) {
        result.push({ path: 'index.html', content: files.html });
    }

    if (files.css) {
        result.push({ path: 'styles.css', content: files.css });
    }

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
 */
export async function autoCreateRepoIfEnabled(projectId, projectName) {
    const autoCreate = localStorage.getItem('github_auto_create') === 'true';
    devLog('Auto-create repo check:', { autoCreate, projectId, projectName });

    if (!autoCreate) {
        devLog('Auto-create repo disabled, skipping');
        return null;
    }

    try {
        const result = await createGitHubRepo(projectId, projectName);
        showToast(`GitHub repo created: ${result.full_name}`);
        return result;
    } catch (error) {
        devError('Auto-create repo failed:', error);
        showToast(`GitHub repo failed: ${error.message}`);
        return null;
    }
}

/**
 * Auto-commit to GitHub after version creation if repo exists
 */
export async function autoCommitIfLinked(projectId, files, prompt) {
    const autoSync = localStorage.getItem('github_auto_sync') === 'true';
    devLog('Auto-sync check:', { autoSync, projectId, filesCount: files?.length || 0 });

    if (!autoSync) {
        devLog('Auto-sync disabled, skipping');
        return null;
    }

    // Check if project has a GitHub repo
    const { data: project, error } = await supabase
        .from('projects')
        .select('github_repo')
        .eq('id', projectId)
        .single();

    if (error) {
        devError('Failed to check project GitHub link:', error);
        return null;
    }

    if (!project?.github_repo) {
        devLog('Project not linked to GitHub, skipping auto-commit');
        return null;
    }

    devLog('Project linked to GitHub:', project.github_repo);

    try {
        const githubFiles = convertFilesForGitHub(files);
        devLog('Converted files for GitHub:', githubFiles.map(f => f.path));

        const message = `Update: ${prompt.slice(0, 72)}${prompt.length > 72 ? '...' : ''}`;
        const result = await commitToGitHub(projectId, githubFiles, message);
        showToast('Synced to GitHub');
        return result;
    } catch (error) {
        devError('Auto-commit failed:', error);
        showToast(`GitHub sync failed: ${error.message}`);
        return null;
    }
}

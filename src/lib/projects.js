/**
 * Project Management
 *
 * Replaces the WebsimSocket collection operations with Supabase queries.
 * Maintains the same interface where possible.
 */

import { supabase, getCurrentUser } from './supabase.js';

/**
 * Get all projects for the current user
 */
export async function getProjects() {
    const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error fetching projects:', error);
        throw error;
    }
    return data || [];
}

/**
 * Get a single project by ID
 */
export async function getProject(projectId) {
    const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .single();

    if (error) {
        console.error('Error fetching project:', error);
        throw error;
    }
    return data;
}

/**
 * Create a new project
 */
export async function createProject(name, options = {}) {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await supabase
        .from('projects')
        .insert({
            user_id: user.id,
            name,
            description: options.description || '',
            current_files: options.files || []
        })
        .select()
        .single();

    if (error) {
        console.error('Error creating project:', error);
        throw error;
    }

    // Optionally create GitHub repo
    if (options.createGitHubRepo) {
        try {
            const repo = await createGitHubRepo(data.id, name);
            await updateProject(data.id, { github_repo: repo.full_name });
            data.github_repo = repo.full_name;
        } catch (err) {
            console.warn('Could not create GitHub repo:', err);
            // Continue without GitHub - user can link later
        }
    }

    return data;
}

/**
 * Update an existing project
 */
export async function updateProject(projectId, updates) {
    const { data, error } = await supabase
        .from('projects')
        .update(updates)
        .eq('id', projectId)
        .select()
        .single();

    if (error) {
        console.error('Error updating project:', error);
        throw error;
    }
    return data;
}

/**
 * Delete a project
 */
export async function deleteProject(projectId) {
    const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', projectId);

    if (error) {
        console.error('Error deleting project:', error);
        throw error;
    }
}

/**
 * Subscribe to project changes (real-time updates)
 */
export function subscribeToProjects(callback) {
    const channel = supabase
        .channel('projects-changes')
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'projects'
            },
            (payload) => {
                callback(payload);
            }
        )
        .subscribe();

    // Return unsubscribe function
    return () => {
        supabase.removeChannel(channel);
    };
}

// ============================================
// VERSION MANAGEMENT
// ============================================

/**
 * Get all versions for a project
 */
export async function getVersions(projectId) {
    const { data, error } = await supabase
        .from('versions')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error fetching versions:', error);
        throw error;
    }
    return data || [];
}

/**
 * Get a single version by ID
 */
export async function getVersion(versionId) {
    const { data, error } = await supabase
        .from('versions')
        .select('*')
        .eq('id', versionId)
        .single();

    if (error) {
        console.error('Error fetching version:', error);
        throw error;
    }
    return data;
}

/**
 * Create a new version (and optionally commit to GitHub)
 */
export async function createVersion(projectId, options) {
    const { prompt, files, description, modelUsed, commitToGitHub = true } = options;

    // Insert version to database
    const { data: version, error } = await supabase
        .from('versions')
        .insert({
            project_id: projectId,
            prompt,
            files,
            description: description || `Generated from: ${prompt.slice(0, 100)}...`,
            model_used: modelUsed
        })
        .select()
        .single();

    if (error) {
        console.error('Error creating version:', error);
        throw error;
    }

    // Update project's current files
    await updateProject(projectId, { current_files: files });

    // Commit to GitHub if enabled
    if (commitToGitHub) {
        try {
            const commitSha = await commitToGitHubRepo(projectId, files, version.description);
            if (commitSha) {
                await supabase
                    .from('versions')
                    .update({ git_commit_sha: commitSha })
                    .eq('id', version.id);
                version.git_commit_sha = commitSha;
            }
        } catch (err) {
            console.warn('Could not commit to GitHub:', err);
            // Version is still saved, just not synced to Git
        }
    }

    return version;
}

/**
 * Subscribe to version changes for a project
 */
export function subscribeToVersions(projectId, callback) {
    const channel = supabase
        .channel(`versions-${projectId}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'versions',
                filter: `project_id=eq.${projectId}`
            },
            (payload) => {
                callback(payload);
            }
        )
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
}

// ============================================
// GITHUB INTEGRATION (via API routes)
// ============================================

/**
 * Create a new GitHub repository for a project
 */
async function createGitHubRepo(projectId, name) {
    const response = await fetch('/api/github/create-repo', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`
        },
        body: JSON.stringify({ projectId, name })
    });

    if (!response.ok) {
        throw new Error('Failed to create GitHub repo');
    }

    return response.json();
}

/**
 * Commit files to GitHub repository
 */
async function commitToGitHubRepo(projectId, files, message) {
    const response = await fetch('/api/github/commit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`
        },
        body: JSON.stringify({ projectId, files, message })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to commit: ${error}`);
    }

    const result = await response.json();
    return result.sha;
}

/**
 * Vercel Serverless Function: Commit to GitHub
 *
 * Commits file changes to a project's GitHub repository.
 * Creates or updates multiple files in a single commit.
 */

import { createClient } from '@supabase/supabase-js';
import { Octokit } from '@octokit/rest';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Authenticate user
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Get user's GitHub token
        const { data: profile } = await supabase
            .from('profiles')
            .select('github_access_token')
            .eq('id', user.id)
            .single();

        if (!profile?.github_access_token) {
            return res.status(400).json({ error: 'GitHub not connected' });
        }

        // Parse request
        const { projectId, files, message } = req.body;

        if (!projectId || !files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Invalid request body' });
        }

        // Get project to find repo
        const { data: project } = await supabase
            .from('projects')
            .select('github_repo, github_default_branch, user_id')
            .eq('id', projectId)
            .single();

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Verify ownership
        if (project.user_id !== user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!project.github_repo) {
            return res.status(400).json({ error: 'Project not linked to GitHub' });
        }

        const [owner, repo] = project.github_repo.split('/');
        const branch = project.github_default_branch || 'main';

        const octokit = new Octokit({ auth: profile.github_access_token });

        // Get the current commit SHA for the branch
        const { data: ref } = await octokit.git.getRef({
            owner,
            repo,
            ref: `heads/${branch}`
        });
        const latestCommitSha = ref.object.sha;

        // Get the tree SHA from the latest commit
        const { data: commit } = await octokit.git.getCommit({
            owner,
            repo,
            commit_sha: latestCommitSha
        });
        const baseTreeSha = commit.tree.sha;

        // Create blobs for each file
        const tree = await Promise.all(
            files.map(async (file) => {
                const { data: blob } = await octokit.git.createBlob({
                    owner,
                    repo,
                    content: Buffer.from(file.content).toString('base64'),
                    encoding: 'base64'
                });

                return {
                    path: file.path,
                    mode: '100644', // File mode
                    type: 'blob',
                    sha: blob.sha
                };
            })
        );

        // Create new tree
        const { data: newTree } = await octokit.git.createTree({
            owner,
            repo,
            base_tree: baseTreeSha,
            tree
        });

        // Create commit
        const { data: newCommit } = await octokit.git.createCommit({
            owner,
            repo,
            message: message || 'Update from SimpleSim',
            tree: newTree.sha,
            parents: [latestCommitSha]
        });

        // Update branch reference
        await octokit.git.updateRef({
            owner,
            repo,
            ref: `heads/${branch}`,
            sha: newCommit.sha
        });

        return res.status(200).json({
            sha: newCommit.sha,
            message: newCommit.message,
            html_url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`
        });

    } catch (error) {
        console.error('Error committing:', error);
        return res.status(500).json({ error: error.message || 'Failed to commit' });
    }
}

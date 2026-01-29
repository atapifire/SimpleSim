/**
 * Vercel Serverless Function: Create GitHub Repository
 *
 * Creates a new GitHub repository for a SimpleSim project.
 * Uses the user's GitHub OAuth token stored in Supabase.
 */

import { createClient } from '@supabase/supabase-js';
import { Octokit } from '@octokit/rest';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Get user from Supabase auth token
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Get user's GitHub access token from profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('github_access_token, github_username')
            .eq('id', user.id)
            .single();

        if (profileError || !profile?.github_access_token) {
            return res.status(400).json({ error: 'GitHub not connected' });
        }

        // Parse request body
        const { projectId, name } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Repository name is required' });
        }

        // Create GitHub repo using user's token
        const octokit = new Octokit({ auth: profile.github_access_token });

        // Sanitize repo name
        const repoName = name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 100);

        const { data: repo } = await octokit.repos.createForAuthenticatedUser({
            name: `simplesim-${repoName}`,
            description: `Created with SimpleSim`,
            private: false, // User can change this
            auto_init: true, // Creates initial commit with README
            has_issues: false,
            has_projects: false,
            has_wiki: false
        });

        // Update project with GitHub repo info
        if (projectId) {
            await supabase
                .from('projects')
                .update({
                    github_repo: repo.full_name,
                    github_default_branch: repo.default_branch
                })
                .eq('id', projectId);
        }

        return res.status(200).json({
            full_name: repo.full_name,
            html_url: repo.html_url,
            default_branch: repo.default_branch
        });

    } catch (error) {
        console.error('Error creating repo:', error);

        // Handle GitHub-specific errors
        if (error.status === 422) {
            return res.status(422).json({ error: 'Repository name already exists' });
        }

        return res.status(500).json({ error: error.message || 'Failed to create repository' });
    }
}

-- SimpleSim Initial Database Schema
-- Run this in Supabase SQL Editor or via CLI

-- Enable UUID extension (usually enabled by default)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- PROFILES TABLE
-- Extended user data (Supabase Auth handles core user)
-- ============================================
CREATE TABLE IF NOT EXISTS profiles (
    id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    github_username TEXT NOT NULL,
    github_avatar_url TEXT,
    -- Encrypted GitHub access token for API operations
    -- Encryption handled at application level
    github_access_token TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PROJECTS TABLE
-- User projects linked to GitHub repositories
-- ============================================
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    -- GitHub repo in format "username/repo-name"
    github_repo TEXT,
    github_default_branch TEXT DEFAULT 'main',
    description TEXT,
    -- Current active files (latest state)
    current_files JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- VERSIONS TABLE
-- Version history for each project (synced with Git commits)
-- ============================================
CREATE TABLE IF NOT EXISTS versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    -- The prompt that generated this version
    prompt TEXT NOT NULL,
    -- File contents: [{path: "index.html", content: "..."}, ...]
    files JSONB NOT NULL,
    -- Human-readable description (used as commit message)
    description TEXT,
    -- Links to actual Git commit after sync
    git_commit_sha TEXT,
    -- AI model used for generation
    model_used TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- API KEYS TABLE (Optional - for server-side encrypted storage)
-- If you want to store encrypted keys in DB instead of localStorage
-- ============================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL, -- 'openrouter', 'huggingface'
    -- Encrypted key data (encrypted with user's PIN client-side)
    encrypted_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider)
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_project_id ON versions(project_id);
CREATE INDEX IF NOT EXISTS idx_versions_created_at ON versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- Users can only access their own data
-- ============================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can only see/edit their own profile
CREATE POLICY "Users can view own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE
    USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
    ON profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

-- Projects: Users can only access their own projects
CREATE POLICY "Users can view own projects"
    ON projects FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create own projects"
    ON projects FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
    ON projects FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
    ON projects FOR DELETE
    USING (auth.uid() = user_id);

-- Versions: Users can access versions of their own projects
CREATE POLICY "Users can view versions of own projects"
    ON versions FOR SELECT
    USING (
        project_id IN (
            SELECT id FROM projects WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create versions for own projects"
    ON versions FOR INSERT
    WITH CHECK (
        project_id IN (
            SELECT id FROM projects WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update versions of own projects"
    ON versions FOR UPDATE
    USING (
        project_id IN (
            SELECT id FROM projects WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete versions of own projects"
    ON versions FOR DELETE
    USING (
        project_id IN (
            SELECT id FROM projects WHERE user_id = auth.uid()
        )
    );

-- API Keys: Users can only access their own keys
CREATE POLICY "Users can view own api keys"
    ON api_keys FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own api keys"
    ON api_keys FOR ALL
    USING (auth.uid() = user_id);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- FUNCTION: Auto-create profile on user signup
-- ============================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO profiles (id, github_username, github_avatar_url)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'user_name', NEW.raw_user_meta_data->>'preferred_username', 'user'),
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$ language 'plpgsql' SECURITY DEFINER;

-- Trigger to auto-create profile
CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_user();

-- SimpleSim Background Jobs & Enhanced Security Schema
-- Migration 003: Jobs table, key sharding support, COPPA compliance
-- Run via: supabase db push

-- ============================================
-- ENHANCED API_KEYS TABLE
-- Stores sharded key shares for zero-knowledge security
-- ============================================

-- Add new columns to existing api_keys table for sharding
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS share_a_vault_id TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS share_b_encrypted TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_label TEXT DEFAULT 'Default Key';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS training_opt_out BOOLEAN DEFAULT true;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS min_age_requirement INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS is_server_encrypted BOOLEAN DEFAULT false;

-- Drop the old encrypted_data column constraint if it exists
-- (we're moving to sharded storage)
ALTER TABLE api_keys ALTER COLUMN encrypted_data DROP NOT NULL;

-- ============================================
-- PROFILES ENHANCEMENTS
-- Add age verification and parental controls
-- ============================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_minor BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES profiles(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS coppa_consent_date TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS gdpr_consent_date TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS data_processing_consent BOOLEAN DEFAULT false;

-- Index for parent-child lookups
CREATE INDEX IF NOT EXISTS idx_profiles_parent_id ON profiles(parent_id) WHERE parent_id IS NOT NULL;

-- ============================================
-- KEY_ASSIGNMENTS TABLE
-- Allows parents to share keys with children
-- ============================================

CREATE TABLE IF NOT EXISTS key_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE NOT NULL,
    child_user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    parent_user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,

    -- Permissions
    can_use_for_generation BOOLEAN DEFAULT true,
    spending_limit_cents INTEGER DEFAULT NULL, -- NULL = unlimited
    spent_cents INTEGER DEFAULT 0,

    -- Safety settings
    require_moderation BOOLEAN DEFAULT true,
    safety_system_prompt TEXT DEFAULT 'You are talking to a young user. Be educational, helpful, and appropriate for all ages.',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NULL,

    UNIQUE(api_key_id, child_user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_key_assignments_child ON key_assignments(child_user_id);
CREATE INDEX IF NOT EXISTS idx_key_assignments_parent ON key_assignments(parent_user_id);

-- RLS for key_assignments
ALTER TABLE key_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Parents can manage their key assignments" ON key_assignments
    FOR ALL USING (auth.uid() = parent_user_id);

CREATE POLICY "Children can view their key assignments" ON key_assignments
    FOR SELECT USING (auth.uid() = child_user_id);

-- ============================================
-- JOBS TABLE
-- Background execution queue with Realtime support
-- ============================================

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,

    -- Configuration
    job_type TEXT NOT NULL CHECK (job_type IN ('simple', 'agent')),
    prompt TEXT NOT NULL,
    current_files JSONB DEFAULT '[]'::jsonb,
    model TEXT NOT NULL,

    -- Security context
    api_key_id UUID REFERENCES api_keys(id),
    is_child_request BOOLEAN DEFAULT false,
    parent_key_owner_id UUID REFERENCES profiles(id),
    safety_system_prompt TEXT,
    training_opt_out BOOLEAN DEFAULT true,

    -- State
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),

    -- Progress (agent mode)
    current_iteration INTEGER DEFAULT 0,
    max_iterations INTEGER DEFAULT 10,
    working_files JSONB DEFAULT '[]'::jsonb,
    messages JSONB DEFAULT '[]'::jsonb,

    -- Results
    result_files JSONB,
    result_description TEXT,
    error_message TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost_cents INTEGER DEFAULT 0,

    -- Timing
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes'),
    last_heartbeat TIMESTAMPTZ,

    -- Version created
    result_version_id UUID REFERENCES versions(id)
);

-- Indexes for job processing
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at) WHERE status = 'pending';

-- RLS for jobs
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own jobs" ON jobs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own jobs" ON jobs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can cancel own jobs" ON jobs
    FOR UPDATE USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Parents can view jobs from their children
CREATE POLICY "Parents can view children jobs" ON jobs
    FOR SELECT USING (
        user_id IN (
            SELECT id FROM profiles WHERE parent_id = auth.uid()
        )
    );

-- ============================================
-- ACTIVE SESSIONS TABLE
-- Tracks unlocked sessions for background job access
-- (Alternative to Redis for free tier - with TTL cleanup)
-- ============================================

CREATE TABLE IF NOT EXISTS active_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,

    -- Session data (encrypted session key for Redis-like caching)
    session_token_hash TEXT NOT NULL, -- Hash of the session token
    encrypted_combined_key TEXT, -- AES encrypted full key for this session

    -- Security
    device_fingerprint TEXT,
    ip_address INET,
    user_agent TEXT,

    -- Timing
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '2 hours'),

    UNIQUE(user_id, session_token_hash)
);

-- Index for session lookups and cleanup
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_expires ON active_sessions(expires_at);

-- RLS
ALTER TABLE active_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own sessions" ON active_sessions
    FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- AUDIT LOG TABLE
-- GDPR/COPPA compliant logging (anonymized for children)
-- ============================================

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,

    -- Event info
    event_type TEXT NOT NULL,
    event_category TEXT NOT NULL, -- 'auth', 'generation', 'key_management', 'data_access'

    -- Details (anonymized for minors)
    details JSONB DEFAULT '{}'::jsonb,

    -- For cost tracking without content
    tokens_used INTEGER,
    cost_cents INTEGER,
    model_used TEXT,

    -- Security context
    ip_address INET,
    user_agent TEXT,
    is_minor_request BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Partition by month for efficient cleanup (GDPR right to be forgotten)
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(event_category);

-- RLS - Users can see their own audit logs
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audit logs" ON audit_log
    FOR SELECT USING (auth.uid() = user_id);

-- Parents can view children's audit logs
CREATE POLICY "Parents can view children audit logs" ON audit_log
    FOR SELECT USING (
        user_id IN (
            SELECT id FROM profiles WHERE parent_id = auth.uid()
        )
    );

-- ============================================
-- FUNCTIONS
-- ============================================

-- Atomic job claiming function (prevents race conditions)
CREATE OR REPLACE FUNCTION claim_pending_job(p_processor_id TEXT DEFAULT NULL)
RETURNS TABLE(job_id UUID, job_data JSONB) AS $$
DECLARE
    claimed_job jobs%ROWTYPE;
BEGIN
    -- Atomically claim the oldest pending job that hasn't expired
    UPDATE jobs
    SET
        status = 'processing',
        started_at = NOW(),
        last_heartbeat = NOW()
    WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
          AND expires_at > NOW()
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING * INTO claimed_job;

    IF claimed_job.id IS NOT NULL THEN
        RETURN QUERY SELECT
            claimed_job.id,
            jsonb_build_object(
                'id', claimed_job.id,
                'user_id', claimed_job.user_id,
                'project_id', claimed_job.project_id,
                'job_type', claimed_job.job_type,
                'prompt', claimed_job.prompt,
                'current_files', claimed_job.current_files,
                'model', claimed_job.model,
                'api_key_id', claimed_job.api_key_id,
                'is_child_request', claimed_job.is_child_request,
                'safety_system_prompt', claimed_job.safety_system_prompt,
                'training_opt_out', claimed_job.training_opt_out,
                'current_iteration', claimed_job.current_iteration,
                'max_iterations', claimed_job.max_iterations,
                'working_files', claimed_job.working_files,
                'messages', claimed_job.messages
            );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update job progress (for chunked agent execution)
CREATE OR REPLACE FUNCTION update_job_progress(
    p_job_id UUID,
    p_iteration INTEGER,
    p_working_files JSONB,
    p_messages JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE jobs
    SET
        current_iteration = p_iteration,
        working_files = p_working_files,
        messages = p_messages,
        last_heartbeat = NOW()
    WHERE id = p_job_id AND status = 'processing';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Complete a job
CREATE OR REPLACE FUNCTION complete_job(
    p_job_id UUID,
    p_result_files JSONB,
    p_description TEXT,
    p_version_id UUID DEFAULT NULL,
    p_tokens_used INTEGER DEFAULT 0,
    p_cost_cents INTEGER DEFAULT 0
) RETURNS VOID AS $$
BEGIN
    UPDATE jobs
    SET
        status = 'completed',
        result_files = p_result_files,
        result_description = p_description,
        result_version_id = p_version_id,
        tokens_used = p_tokens_used,
        cost_cents = p_cost_cents,
        completed_at = NOW()
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Fail a job
CREATE OR REPLACE FUNCTION fail_job(
    p_job_id UUID,
    p_error_message TEXT
) RETURNS VOID AS $$
BEGIN
    UPDATE jobs
    SET
        status = 'failed',
        error_message = p_error_message,
        completed_at = NOW()
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup expired sessions and jobs
CREATE OR REPLACE FUNCTION cleanup_expired() RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
BEGIN
    -- Delete expired sessions
    DELETE FROM active_sessions WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Mark expired pending jobs as failed
    UPDATE jobs
    SET status = 'failed', error_message = 'Job expired'
    WHERE status = 'pending' AND expires_at < NOW();

    -- Mark stale processing jobs as failed (no heartbeat for 5 minutes)
    UPDATE jobs
    SET status = 'failed', error_message = 'Job processor timeout'
    WHERE status = 'processing'
      AND last_heartbeat < NOW() - INTERVAL '5 minutes';

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get user's available API key (handles parent-child delegation)
CREATE OR REPLACE FUNCTION get_user_api_key(p_user_id UUID)
RETURNS TABLE(
    key_id UUID,
    owner_id UUID,
    is_delegated BOOLEAN,
    training_opt_out BOOLEAN,
    safety_prompt TEXT
) AS $$
DECLARE
    user_profile profiles%ROWTYPE;
BEGIN
    -- Get user profile
    SELECT * INTO user_profile FROM profiles WHERE id = p_user_id;

    -- Check if user is a minor with parent
    IF user_profile.is_minor AND user_profile.parent_id IS NOT NULL THEN
        -- Return assigned key from parent
        RETURN QUERY
        SELECT
            ka.api_key_id,
            ka.parent_user_id,
            true,
            ak.training_opt_out OR true, -- Always opt-out for minors
            ka.safety_system_prompt
        FROM key_assignments ka
        JOIN api_keys ak ON ak.id = ka.api_key_id
        WHERE ka.child_user_id = p_user_id
          AND ka.can_use_for_generation = true
          AND (ka.expires_at IS NULL OR ka.expires_at > NOW())
          AND (ka.spending_limit_cents IS NULL OR ka.spent_cents < ka.spending_limit_cents)
        LIMIT 1;
    ELSE
        -- Return user's own key
        RETURN QUERY
        SELECT
            ak.id,
            ak.user_id,
            false,
            ak.training_opt_out,
            NULL::TEXT
        FROM api_keys ak
        WHERE ak.user_id = p_user_id
          AND ak.provider = 'openrouter'
        LIMIT 1;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- REALTIME
-- Enable realtime for jobs table
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE jobs;

-- ============================================
-- SCHEDULED CLEANUP
-- Create a cron job to cleanup expired data (requires pg_cron extension)
-- Note: Enable pg_cron in Supabase Dashboard -> Database -> Extensions
-- ============================================

-- This would be run manually or via Supabase scheduled functions:
-- SELECT cron.schedule('cleanup-expired', '*/5 * * * *', 'SELECT cleanup_expired()');

-- ============================================
-- GRANTS
-- ============================================

GRANT EXECUTE ON FUNCTION claim_pending_job TO service_role;
GRANT EXECUTE ON FUNCTION update_job_progress TO service_role;
GRANT EXECUTE ON FUNCTION complete_job TO service_role;
GRANT EXECUTE ON FUNCTION fail_job TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_expired TO service_role;
GRANT EXECUTE ON FUNCTION get_user_api_key TO authenticated, service_role;

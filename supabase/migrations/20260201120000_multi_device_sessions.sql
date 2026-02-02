-- Multi-Device Session Support Migration
-- Allows users to have separate API key pairs per device
-- Each device stores its own Share B locally, server stores Share A per device

-- ============================================
-- API_KEYS: Add device_id column
-- ============================================

-- Add device_id column to api_keys (nullable for backward compatibility)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Add device_label for user-friendly device identification
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS device_label TEXT;

-- Drop the old unique constraint if it exists (user_id, provider)
-- We need to support multiple keys per user (one per device)
DO $$
BEGIN
    -- Check if constraint exists before trying to drop
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'api_keys_user_id_provider_key'
        AND conrelid = 'api_keys'::regclass
    ) THEN
        ALTER TABLE api_keys DROP CONSTRAINT api_keys_user_id_provider_key;
    END IF;
END $$;

-- Create new unique constraint: one key per user per device per provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_device_provider
ON api_keys(user_id, device_id, provider)
WHERE device_id IS NOT NULL;

-- Index for querying by user and provider (without device for legacy)
CREATE INDEX IF NOT EXISTS idx_api_keys_user_provider
ON api_keys(user_id, provider);

-- ============================================
-- ACTIVE_SESSIONS: Add device_id column
-- ============================================

-- Add device_id column to active_sessions
ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Drop old unique constraint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'active_sessions_user_id_session_token_hash_key'
        AND conrelid = 'active_sessions'::regclass
    ) THEN
        ALTER TABLE active_sessions DROP CONSTRAINT active_sessions_user_id_session_token_hash_key;
    END IF;
END $$;

-- Create new unique constraint: one session per user per device
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_sessions_user_device
ON active_sessions(user_id, device_id)
WHERE device_id IS NOT NULL;

-- Keep index for session token lookup
CREATE INDEX IF NOT EXISTS idx_active_sessions_token_hash
ON active_sessions(session_token_hash);

-- ============================================
-- FUNCTION: Get API key for job processing
-- Updated to handle multi-device - gets ANY valid session for the user
-- ============================================

CREATE OR REPLACE FUNCTION get_user_session_key(p_user_id UUID)
RETURNS TABLE(
    session_id UUID,
    encrypted_key TEXT,
    device_id TEXT,
    expires_at TIMESTAMPTZ
) AS $$
BEGIN
    -- Return any valid (non-expired) session for this user
    -- Jobs can use any device's session since the decrypted key is the same
    RETURN QUERY
    SELECT
        s.id,
        s.encrypted_combined_key,
        s.device_id,
        s.expires_at
    FROM active_sessions s
    WHERE s.user_id = p_user_id
      AND s.expires_at > NOW()
    ORDER BY s.expires_at DESC  -- Prefer session with longest remaining time
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_user_session_key TO service_role;

-- ============================================
-- FUNCTION: List user's devices with API keys
-- ============================================

CREATE OR REPLACE FUNCTION list_user_devices(p_user_id UUID)
RETURNS TABLE(
    key_id UUID,
    device_id TEXT,
    device_label TEXT,
    provider TEXT,
    has_active_session BOOLEAN,
    session_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        k.id,
        k.device_id,
        k.device_label,
        k.provider,
        EXISTS(
            SELECT 1 FROM active_sessions s
            WHERE s.user_id = p_user_id
            AND s.device_id = k.device_id
            AND s.expires_at > NOW()
        ),
        (
            SELECT s.expires_at FROM active_sessions s
            WHERE s.user_id = p_user_id
            AND s.device_id = k.device_id
            AND s.expires_at > NOW()
            LIMIT 1
        ),
        k.created_at
    FROM api_keys k
    WHERE k.user_id = p_user_id
      AND k.device_id IS NOT NULL
    ORDER BY k.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION list_user_devices TO authenticated, service_role;

-- ============================================
-- FUNCTION: Revoke device access
-- ============================================

CREATE OR REPLACE FUNCTION revoke_device_access(p_user_id UUID, p_device_id TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    deleted_count INTEGER := 0;
BEGIN
    -- Delete the API key for this device
    DELETE FROM api_keys
    WHERE user_id = p_user_id AND device_id = p_device_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Delete any active sessions for this device
    DELETE FROM active_sessions
    WHERE user_id = p_user_id AND device_id = p_device_id;

    -- Log the event
    INSERT INTO audit_log (user_id, event_type, event_category, details)
    VALUES (p_user_id, 'device_revoked', 'key_management',
            jsonb_build_object('device_id', p_device_id));

    RETURN deleted_count > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION revoke_device_access TO authenticated, service_role;

-- ============================================
-- Update cleanup function to handle device sessions
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_expired() RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
    temp_count INTEGER := 0;
BEGIN
    -- Delete expired sessions (all devices)
    DELETE FROM active_sessions WHERE expires_at < NOW();
    GET DIAGNOSTICS temp_count = ROW_COUNT;
    deleted_count := deleted_count + temp_count;

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

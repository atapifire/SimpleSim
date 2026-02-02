-- Add status_message column to jobs table
-- This column stores human-readable status updates shown to users in the UI
-- Migration 009: Status message for detailed job progress

-- Add the status_message column to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_message TEXT;

-- Index for jobs that need status updates (processing jobs)
COMMENT ON COLUMN jobs.status_message IS 'Human-readable status message shown to user during job processing';

-- Update claim_pending_job function to include status_message in returned data
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
        last_heartbeat = NOW(),
        status_message = 'Starting job...'
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
                'messages', claimed_job.messages,
                'status_message', claimed_job.status_message
            );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

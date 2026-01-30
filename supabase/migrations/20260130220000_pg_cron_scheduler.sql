-- SimpleSim pg_cron Scheduler Setup
-- More reliable than GitHub Actions cron for cleanup tasks
--
-- Prerequisites:
-- 1. Enable pg_cron extension in Supabase Dashboard -> Database -> Extensions
-- 2. Run this migration: supabase db push

-- Enable required extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant cron schema access
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- Remove existing jobs if they exist (idempotent)
DO $$
BEGIN
    PERFORM cron.unschedule('simplesim-cleanup');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Schedule cleanup to run every minute
-- This handles:
-- 1. Deleting expired sessions
-- 2. Marking expired pending jobs as failed
-- 3. Marking stale processing jobs as failed (no heartbeat for 5 min)
SELECT cron.schedule(
    'simplesim-cleanup',
    '* * * * *',
    $$ SELECT cleanup_expired() $$
);

-- Note: Actual job PROCESSING is done by:
-- 1. GitHub Actions cron (calls job-scheduler Edge Function every minute)
-- 2. Manual trigger via Supabase Dashboard or API
--
-- pg_cron only handles CLEANUP because calling Edge Functions requires
-- service_role key which shouldn't be stored in the database.

-- Helpful queries for monitoring:
--
-- View scheduled jobs:
-- SELECT * FROM cron.job;
--
-- View recent job runs:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
--
-- Manually run cleanup:
-- SELECT cleanup_expired();
--
-- Check pending jobs:
-- SELECT id, status, created_at, expires_at FROM jobs WHERE status = 'pending';

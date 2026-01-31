-- ============================================
-- Queue Improvements Migration
--
-- Implements reliable job processing with:
-- 1. Database trigger for instant processing (< 1 sec)
-- 2. pg_cron backup scheduler (every minute)
-- 3. Uses pg_net for async HTTP calls
-- 4. Stores secrets in Supabase Vault
--
-- Prerequisites (run in Dashboard BEFORE this migration):
-- 1. Enable pg_net extension: Database → Extensions → pg_net
-- 2. Store service key in Vault (see bottom of file)
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Grant permissions
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT USAGE ON SCHEMA net TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

-- ============================================
-- Function: Trigger job processing via HTTP
-- Called by both INSERT trigger and pg_cron
-- ============================================
CREATE OR REPLACE FUNCTION trigger_job_processing(job_id UUID DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  service_key TEXT;
  request_body JSONB;
  target_url TEXT := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/process-job';
BEGIN
  -- Get service key from vault
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'supabase_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not access vault: %', SQLERRM;
    RETURN;
  END;

  IF service_key IS NULL THEN
    RAISE WARNING 'Service role key not found in vault - please add it via Dashboard';
    RETURN;
  END IF;

  -- Build request body
  IF job_id IS NOT NULL THEN
    request_body := jsonb_build_object('jobId', job_id::text);
  ELSE
    request_body := '{}'::jsonb;
  END IF;

  -- Call process-job Edge Function asynchronously via pg_net
  PERFORM net.http_post(
    url := target_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := request_body
  );

  RAISE NOTICE 'Triggered job processing for job_id: %', COALESCE(job_id::text, 'next-pending');
END;
$$;

-- ============================================
-- Function: Called on job INSERT
-- ============================================
CREATE OR REPLACE FUNCTION on_job_inserted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only trigger for new pending jobs
  IF NEW.status = 'pending' THEN
    -- Small delay to ensure transaction commits before processing
    -- pg_net is async so this just queues the request
    PERFORM trigger_job_processing(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================
-- Create INSERT trigger on jobs table
-- ============================================
DROP TRIGGER IF EXISTS job_inserted_trigger ON jobs;

CREATE TRIGGER job_inserted_trigger
  AFTER INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION on_job_inserted();

-- ============================================
-- Function: Scheduler backup (processes any pending jobs)
-- Called by pg_cron every minute
-- ============================================
CREATE OR REPLACE FUNCTION run_job_scheduler()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  service_key TEXT;
  scheduler_url TEXT := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler';
  pending_count INTEGER;
BEGIN
  -- Check if there are any pending jobs first
  SELECT COUNT(*) INTO pending_count
  FROM jobs
  WHERE status = 'pending'
    AND expires_at > NOW();

  -- Only call scheduler if there are pending jobs
  IF pending_count = 0 THEN
    RETURN;
  END IF;

  -- Get service key from vault
  BEGIN
    SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets
    WHERE name = 'supabase_service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not access vault for scheduler: %', SQLERRM;
    RETURN;
  END;

  IF service_key IS NULL THEN
    RAISE WARNING 'Service role key not found in vault';
    RETURN;
  END IF;

  -- Call job-scheduler Edge Function
  PERFORM net.http_post(
    url := scheduler_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb
  );

  RAISE NOTICE 'Scheduler triggered for % pending jobs', pending_count;
END;
$$;

-- ============================================
-- Schedule backup processor (every minute)
-- ============================================
DO $$
BEGIN
  -- Remove old schedulers if they exist
  PERFORM cron.unschedule('backup-job-processor');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('simplesim-job-scheduler');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Schedule the backup processor to run every minute
SELECT cron.schedule(
  'simplesim-job-scheduler',
  '* * * * *',
  $$ SELECT run_job_scheduler(); $$
);

-- ============================================
-- Grant execute permissions
-- ============================================
GRANT EXECUTE ON FUNCTION trigger_job_processing TO postgres, service_role;
GRANT EXECUTE ON FUNCTION on_job_inserted TO postgres, service_role;
GRANT EXECUTE ON FUNCTION run_job_scheduler TO postgres, service_role;

-- ============================================
-- Helpful monitoring queries (run manually)
-- ============================================
COMMENT ON FUNCTION trigger_job_processing IS 'Triggers job processing via Edge Function. Can be called with job_id for specific job or NULL for next pending.';
COMMENT ON FUNCTION run_job_scheduler IS 'Backup scheduler that runs every minute to process any pending jobs.';

-- View scheduled cron jobs:
-- SELECT * FROM cron.job;

-- View recent cron job runs:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Check pending jobs:
-- SELECT id, status, created_at, expires_at FROM jobs WHERE status = 'pending';

-- Check pg_net request queue:
-- SELECT * FROM net._http_response ORDER BY created DESC LIMIT 10;

-- ============================================
-- MANUAL STEP REQUIRED: Store service key in Vault
-- Run this in SQL Editor (replace with your actual key):
--
-- INSERT INTO vault.secrets (name, secret)
-- VALUES ('supabase_service_role_key', 'your-service-role-key-here')
-- ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;
-- ============================================

-- SimpleSim: Reliable Job Scheduler using pg_cron + pg_net
-- This replaces the unreliable GitHub Actions cron
--
-- Prerequisites (enable in Supabase Dashboard -> Database -> Extensions):
-- 1. pg_cron - for scheduled jobs
-- 2. pg_net - for HTTP requests from database
--
-- After running this migration, set the service role key:
-- UPDATE vault.secrets SET secret = 'your-service-role-key' WHERE name = 'service_role_key';

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Store the service role key securely (you'll need to update this)
-- First, check if vault schema exists
DO $$
BEGIN
    -- Try to insert into vault.secrets if it exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'vault' AND table_name = 'secrets') THEN
        INSERT INTO vault.secrets (name, secret)
        VALUES ('service_role_key', 'REPLACE_WITH_YOUR_SERVICE_ROLE_KEY')
        ON CONFLICT (name) DO NOTHING;
    END IF;
END $$;

-- Create function to trigger the job scheduler via HTTP
CREATE OR REPLACE FUNCTION trigger_job_scheduler_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    service_key TEXT;
    supabase_url TEXT := 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
    request_id BIGINT;
BEGIN
    -- Get service role key from vault or app settings
    BEGIN
        SELECT decrypted_secret INTO service_key
        FROM vault.decrypted_secrets
        WHERE name = 'service_role_key';
    EXCEPTION WHEN OTHERS THEN
        -- Vault not available, try app settings
        service_key := current_setting('app.settings.service_role_key', true);
    END;

    IF service_key IS NULL OR service_key = '' OR service_key = 'REPLACE_WITH_YOUR_SERVICE_ROLE_KEY' THEN
        RAISE NOTICE 'Service role key not configured - skipping HTTP trigger';
        -- Still run local cleanup
        PERFORM cleanup_expired();
        RETURN;
    END IF;

    -- Call the job-scheduler Edge Function
    SELECT net.http_post(
        url := supabase_url || '/functions/v1/job-scheduler',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000  -- 55 second timeout (cron runs every minute)
    ) INTO request_id;

    RAISE NOTICE 'Job scheduler HTTP request sent, ID: %', request_id;

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Failed to trigger job scheduler: %', SQLERRM;
    -- Still run local cleanup even if HTTP fails
    PERFORM cleanup_expired();
END;
$$;

-- Remove any existing cron jobs for this
DO $$
BEGIN
    PERFORM cron.unschedule('simplesim-http-scheduler');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    PERFORM cron.unschedule('simplesim-cleanup');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Schedule the HTTP trigger to run every minute
-- This is MUCH more reliable than GitHub Actions
SELECT cron.schedule(
    'simplesim-http-scheduler',
    '* * * * *',  -- Every minute
    $$ SELECT trigger_job_scheduler_http() $$
);

-- Also keep the direct cleanup as a backup (runs every 5 minutes)
SELECT cron.schedule(
    'simplesim-cleanup-backup',
    '*/5 * * * *',  -- Every 5 minutes
    $$ SELECT cleanup_expired() $$
);

-- Grant necessary permissions
GRANT USAGE ON SCHEMA net TO postgres;
GRANT EXECUTE ON FUNCTION trigger_job_scheduler_http() TO postgres;

-- View scheduled jobs
-- SELECT * FROM cron.job;

-- View recent job runs
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- Check HTTP request results
-- SELECT * FROM net._http_response ORDER BY created DESC LIMIT 10;

COMMENT ON FUNCTION trigger_job_scheduler_http() IS
'Triggers the job-scheduler Edge Function via HTTP. Runs every minute via pg_cron.
Much more reliable than GitHub Actions cron.';

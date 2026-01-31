-- SimpleSim: Setup pg_cron for Reliable Job Scheduling
--
-- RUN THIS IN SUPABASE DASHBOARD -> SQL EDITOR
-- Replace YOUR_SERVICE_ROLE_KEY with your actual key from:
-- Dashboard -> Settings -> API -> service_role key
--
-- Prerequisites: Enable these extensions in Dashboard -> Database -> Extensions:
-- 1. pg_cron
-- 2. pg_net

-- Step 1: Enable extensions (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Step 2: Create the scheduler function
-- This calls your Edge Function every minute
CREATE OR REPLACE FUNCTION public.trigger_job_scheduler_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    request_id BIGINT;
    -- ⚠️ REPLACE THIS WITH YOUR ACTUAL SERVICE ROLE KEY ⚠️
    service_key TEXT := 'YOUR_SERVICE_ROLE_KEY';
BEGIN
    -- Call the job-scheduler Edge Function
    SELECT net.http_post(
        url := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
    ) INTO request_id;

    RAISE NOTICE 'Scheduler triggered, request ID: %', request_id;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Scheduler trigger failed: %', SQLERRM;
END;
$$;

-- Step 3: Remove old cron jobs (if any)
SELECT cron.unschedule('simplesim-http-scheduler') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'simplesim-http-scheduler');
SELECT cron.unschedule('simplesim-cleanup') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'simplesim-cleanup');
SELECT cron.unschedule('simplesim-cleanup-backup') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'simplesim-cleanup-backup');

-- Step 4: Schedule the job to run every minute
SELECT cron.schedule(
    'simplesim-http-scheduler',
    '* * * * *',
    $$ SELECT public.trigger_job_scheduler_http() $$
);

-- Step 5: Also schedule cleanup every 5 minutes (backup)
SELECT cron.schedule(
    'simplesim-cleanup-backup',
    '*/5 * * * *',
    $$ SELECT public.cleanup_expired() $$
);

-- Verify setup
SELECT jobid, jobname, schedule, command FROM cron.job WHERE jobname LIKE 'simplesim%';

-- To check if it's working, wait 1-2 minutes then run:
-- SELECT * FROM cron.job_run_details WHERE jobname LIKE 'simplesim%' ORDER BY start_time DESC LIMIT 10;

-- To check HTTP request results:
-- SELECT id, status_code, created FROM net._http_response ORDER BY created DESC LIMIT 10;

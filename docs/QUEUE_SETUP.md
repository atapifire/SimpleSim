# Queue System Setup Guide

This guide walks you through setting up the reliable job queue system for SimpleSim.

## Prerequisites

- Supabase project access (Dashboard)
- Service role key (found in Project Settings → API)

---

## Step 1: Enable pg_net Extension

1. Go to **Supabase Dashboard** → **Database** → **Extensions**
2. Search for `pg_net`
3. Click **Enable**

> pg_net allows PostgreSQL to make HTTP requests, which is how the trigger calls the Edge Function.

---

## Step 2: Store Service Role Key in Vault

The service role key is needed for the database to authenticate with Edge Functions.

1. Go to **Supabase Dashboard** → **SQL Editor**
2. Run this SQL (replace `YOUR_SERVICE_ROLE_KEY` with your actual key):

```sql
-- Store service role key in Vault
INSERT INTO vault.secrets (name, secret)
VALUES ('supabase_service_role_key', 'YOUR_SERVICE_ROLE_KEY')
ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;

-- Verify it was stored
SELECT name, created_at FROM vault.secrets WHERE name = 'supabase_service_role_key';
```

> **Where to find your service role key:**
> Dashboard → Project Settings → API → `service_role` (secret)

> **Security Note:** The key is encrypted at rest in Vault. Never commit it to git.

---

## Step 3: Run the Migration

Option A: **Via Supabase CLI**
```bash
supabase db push
```

Option B: **Via Dashboard SQL Editor**
Copy the contents of `supabase/migrations/20260131_queue_improvements.sql` and run it.

---

## Step 4: Verify Setup

Run these queries in **SQL Editor** to verify everything is working:

```sql
-- Check pg_net is enabled
SELECT * FROM pg_extension WHERE extname = 'pg_net';

-- Check Vault secret exists
SELECT name, created_at FROM vault.secrets WHERE name = 'supabase_service_role_key';

-- Check trigger is created
SELECT tgname, tgrelid::regclass, tgenabled
FROM pg_trigger
WHERE tgname = 'job_inserted_trigger';

-- Check cron job is scheduled
SELECT * FROM cron.job WHERE jobname = 'simplesim-job-scheduler';

-- Check functions exist
SELECT proname FROM pg_proc WHERE proname IN ('trigger_job_processing', 'on_job_inserted', 'run_job_scheduler');
```

---

## Step 5: Test the Queue

1. **Submit a test job** through the SimpleSim UI
2. **Check it processes quickly** (should start within 1-2 seconds)
3. **Monitor in SQL Editor:**

```sql
-- Watch job status changes
SELECT id, status, created_at, started_at, completed_at
FROM jobs
ORDER BY created_at DESC
LIMIT 5;

-- Check pg_net request log (to see if trigger fired)
SELECT id, url, status_code, created
FROM net._http_response
ORDER BY created DESC
LIMIT 10;

-- Check cron run history
SELECT * FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'simplesim-job-scheduler')
ORDER BY start_time DESC
LIMIT 5;
```

---

## Troubleshooting

### Job stays in "pending" status

1. **Check Vault secret:**
   ```sql
   SELECT name FROM vault.secrets WHERE name = 'supabase_service_role_key';
   ```
   If missing, add it per Step 2.

2. **Check pg_net requests:**
   ```sql
   SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
   ```
   Look for failed requests (status_code != 200).

3. **Check trigger exists:**
   ```sql
   SELECT * FROM pg_trigger WHERE tgname = 'job_inserted_trigger';
   ```

4. **Test trigger manually:**
   ```sql
   SELECT trigger_job_processing('your-job-id-here'::uuid);
   ```

### "Service role key not found" warnings

The Vault secret isn't set up correctly. Re-run Step 2.

### pg_net errors

Make sure the pg_net extension is enabled (Step 1).

### Cron not running

Check cron job exists:
```sql
SELECT * FROM cron.job;
```

If missing, re-run the migration.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    USER SUBMITS JOB                          │
│                  (INSERT into jobs table)                    │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
     ┌────────────────┐ ┌──────────┐ ┌────────────────┐
     │ DATABASE       │ │ pg_cron  │ │ CLIENT         │
     │ TRIGGER        │ │ BACKUP   │ │ FALLBACK       │
     │                │ │          │ │                │
     │ on_job_insert  │ │ Every    │ │ After 10 sec   │
     │ fires          │ │ minute   │ │ if still       │
     │ immediately    │ │          │ │ pending        │
     └────────────────┘ └──────────┘ └────────────────┘
              │               │               │
              │  pg_net HTTP  │  pg_net HTTP  │  fetch()
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    ┌─────────────────┐
                    │ process-job     │
                    │ Edge Function   │
                    │                 │
                    │ • Claims job    │
                    │ • Gets API key  │
                    │ • Runs AI       │
                    │ • Saves result  │
                    └─────────────────┘
```

---

## Reliability Summary

| Trigger | Latency | When It Fires |
|---------|---------|---------------|
| Database Trigger | < 1 sec | Immediately on INSERT |
| pg_cron Backup | < 60 sec | Every minute (if pending jobs exist) |
| Client Fallback | 10 sec | If job still pending after 10 sec |

**Expected result:** Jobs start processing within 1-2 seconds of submission.

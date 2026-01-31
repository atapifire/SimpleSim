# Background Job Queue Improvement Plan

## Current Problem

The background job queue is unreliable:
- GitHub Actions cron runs ~once per hour instead of every minute
- Jobs get stuck in "pending" status for 5+ minutes
- Users experience inconsistent processing times

## Root Cause

GitHub Actions cron is notoriously unreliable:
- Free tier has significant delays and skipped runs
- No SLA on timing - can be delayed by minutes or hours
- Not designed for sub-minute scheduling

## Proposed Solution: Database-Driven Processing

Replace GitHub Actions with Supabase-native solutions that are more reliable and free.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     JOB SUBMISSION                               │
│  Client → jobs table INSERT                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌────────────────┐ ┌──────────┐ ┌────────────────┐
     │ DATABASE       │ │ pg_cron  │ │ CLIENT         │
     │ WEBHOOK        │ │ BACKUP   │ │ FALLBACK       │
     │ (instant)      │ │ (1 min)  │ │ (10 sec)       │
     └────────────────┘ └──────────┘ └────────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    ┌─────────────────┐
                    │ process-job     │
                    │ Edge Function   │
                    └─────────────────┘
```

### Solution Components

#### 1. Database Webhook (PRIMARY - Instant Processing)

**How it works:**
- When a job is INSERTed into `jobs` table, a webhook fires immediately
- Webhook calls `process-job` Edge Function with the job ID
- Near-zero latency from submission to processing

**Implementation:**
```sql
-- Create webhook via Supabase Dashboard or SQL:
-- Dashboard: Database → Webhooks → Create new webhook
-- Table: jobs
-- Events: INSERT
-- URL: https://[project].supabase.co/functions/v1/process-job
-- Method: POST
-- Headers: Authorization: Bearer [service_role_key from Vault]
```

**Pros:**
- Instant processing (< 1 second after job creation)
- Built into Supabase, no external dependencies
- Uses pg_net (async, non-blocking)

**Cons:**
- Need to store service_role_key securely (use Supabase Vault)
- If webhook fails, need backup mechanism

#### 2. pg_cron + pg_net (BACKUP - Every Minute)

**How it works:**
- pg_cron runs every minute
- Calls job-scheduler Edge Function via pg_net
- Picks up any jobs missed by webhook

**Implementation:**
```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Store service key in Vault
SELECT vault.create_secret(
  'service_role_key',
  '[your-service-role-key]'
);

-- Schedule job processor
SELECT cron.schedule(
  'process-pending-jobs',
  '* * * * *',  -- Every minute
  $$
  SELECT net.http_post(
    url := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

**Pros:**
- Reliable backup if webhook fails
- Catches any missed jobs
- Built into Supabase

**Cons:**
- 1 minute max delay (acceptable for backup)
- Need to enable pg_net extension

#### 3. Client-Side Fallback (SAFETY NET - 10 Seconds)

**How it works:**
- Client submits job and starts a 10-second timer
- If job status doesn't change to "processing" within 10s, client calls scheduler directly
- Ensures jobs never get stuck

**Implementation (JavaScript):**
```javascript
async function submitJobWithFallback(projectId, prompt, files, options) {
  const job = await submitJob(projectId, prompt, files, options);

  // Start fallback timer
  const fallbackTimer = setTimeout(async () => {
    const { data } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', job.id)
      .single();

    if (data?.status === 'pending') {
      console.log('Job still pending after 10s, triggering manual process');
      // Call process-job directly (requires session to be unlocked)
      await triggerJobProcessing(job.id);
    }
  }, 10000);

  // Clear timer when job starts processing
  const subscription = subscribeToJob(job.id, {
    onStatusChange: (status) => {
      if (status === 'processing') {
        clearTimeout(fallbackTimer);
      }
    }
  });

  return { job, subscription };
}
```

**Pros:**
- Guarantees job processing within 10 seconds
- Works even if all server-side triggers fail
- No additional infrastructure needed

**Cons:**
- Requires client to stay on page for 10 seconds
- Uses client's session (but that's already required)

---

## Implementation Steps

### Phase 1: Enable pg_net and Vault (Database Setup)

1. **Enable pg_net extension:**
   - Go to Supabase Dashboard → Database → Extensions
   - Search for "pg_net" and enable it

2. **Store service_role_key in Vault:**
   ```sql
   -- In SQL Editor
   SELECT vault.create_secret(
     'supabase_service_role_key',
     'eyJhbGc...[your key]'
   );
   ```

3. **Create migration file:**
   - `supabase/migrations/20260131_queue_improvements.sql`

### Phase 2: Database Webhook (Instant Processing)

1. **Create webhook in Dashboard:**
   - Database → Webhooks → New Webhook
   - Name: `process-new-job`
   - Table: `jobs`
   - Events: `INSERT`
   - Type: Supabase Edge Function
   - Function: `process-job`
   - Method: POST

2. **Or via SQL:**
   ```sql
   -- Webhook creation via SQL (alternative)
   SELECT supabase_functions.http_request(
     'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/process-job',
     'POST',
     '{"Content-Type": "application/json"}',
     '{}',
     '5000'
   );
   ```

### Phase 3: pg_cron Backup Scheduler

1. **Update migration to add pg_net scheduler:**
   ```sql
   -- Schedule backup processor (catches any missed jobs)
   SELECT cron.schedule(
     'backup-job-processor',
     '* * * * *',
     $$
     SELECT net.http_post(
       url := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (
           SELECT decrypted_secret
           FROM vault.decrypted_secrets
           WHERE name = 'supabase_service_role_key'
         )
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```

### Phase 4: Client-Side Fallback

1. **Update job-queue.js:**
   - Add fallback timer to `submitJob()`
   - Add `triggerJobProcessing()` function
   - Clear timer when job starts processing

### Phase 5: Remove GitHub Actions Dependency

1. **Disable GitHub Actions workflow:**
   - Delete or disable `.github/workflows/job-scheduler.yml`
   - Or keep as last-resort backup (runs every 5 minutes instead of every minute)

---

## Migration SQL (Complete)

```sql
-- File: supabase/migrations/20260131_queue_improvements.sql

-- ============================================
-- Enable required extensions
-- ============================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================
-- Store service role key in Vault
-- (Run this manually in Dashboard SQL Editor - don't commit the actual key!)
-- ============================================
-- SELECT vault.create_secret(
--   'supabase_service_role_key',
--   'your-service-role-key-here'
-- );

-- ============================================
-- Create function to process jobs via HTTP
-- ============================================
CREATE OR REPLACE FUNCTION trigger_job_processing(job_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  service_key TEXT;
BEGIN
  -- Get service key from vault
  SELECT decrypted_secret INTO service_key
  FROM vault.decrypted_secrets
  WHERE name = 'supabase_service_role_key';

  IF service_key IS NULL THEN
    RAISE WARNING 'Service role key not found in vault';
    RETURN;
  END IF;

  -- Call process-job Edge Function
  PERFORM net.http_post(
    url := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/process-job',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object('jobId', job_id)
  );
END;
$$;

-- ============================================
-- Create trigger for instant job processing
-- ============================================
CREATE OR REPLACE FUNCTION on_job_inserted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Only trigger for new pending jobs
  IF NEW.status = 'pending' THEN
    PERFORM trigger_job_processing(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS job_inserted_trigger ON jobs;

-- Create trigger
CREATE TRIGGER job_inserted_trigger
  AFTER INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION on_job_inserted();

-- ============================================
-- Schedule backup processor (every minute)
-- ============================================
DO $$
BEGIN
  -- Remove old scheduler if exists
  PERFORM cron.unschedule('backup-job-processor');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'backup-job-processor',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'supabase_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ============================================
-- Grant necessary permissions
-- ============================================
GRANT USAGE ON SCHEMA net TO postgres;
GRANT EXECUTE ON FUNCTION trigger_job_processing TO postgres;
GRANT EXECUTE ON FUNCTION on_job_inserted TO postgres;
```

---

## Expected Results

| Trigger | Latency | Reliability | Cost |
|---------|---------|-------------|------|
| Database Webhook/Trigger | < 1 second | High | Free |
| pg_cron Backup | < 60 seconds | High | Free |
| Client Fallback | < 10 seconds | Medium | Free |
| GitHub Actions (old) | 1-60+ minutes | Low | Free |

**Total expected latency: < 1 second** (with 10-second and 60-second fallbacks)

---

## Security Considerations

1. **Service Role Key Storage:**
   - Store in Supabase Vault (encrypted at rest)
   - Never commit to git
   - Rotate periodically

2. **Edge Function Access:**
   - `process-job` already validates job ownership
   - Use `--no-verify-jwt` but validate internally
   - Add rate limiting if needed

3. **Trigger Security:**
   - Use SECURITY DEFINER for controlled execution
   - Limit trigger to specific operations

---

## Testing Plan

1. **Unit Tests:**
   - Verify trigger fires on INSERT
   - Verify pg_cron job runs every minute
   - Verify client fallback activates after 10s

2. **Integration Tests:**
   - Submit job, verify processing starts < 2 seconds
   - Disable webhook, verify pg_cron catches job < 60 seconds
   - Disable both, verify client fallback works

3. **Load Tests:**
   - Submit 10 jobs simultaneously
   - Verify all process without conflicts

---

## Rollback Plan

If issues occur:
1. Disable trigger: `DROP TRIGGER job_inserted_trigger ON jobs;`
2. Disable pg_cron: `SELECT cron.unschedule('backup-job-processor');`
3. Re-enable GitHub Actions workflow

---

## References

- [Supabase Cron](https://supabase.com/modules/cron)
- [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Database Webhooks](https://supabase.com/docs/guides/database/webhooks)
- [pg_cron Extension](https://supabase.com/docs/guides/database/extensions/pg_cron)
- [Supabase Vault](https://supabase.com/docs/guides/database/vault)

# Background Jobs Setup Guide

This guide explains how to set up the background execution system for SimpleSim, enabling AI generation to continue even when users close their browser.

## Overview

The system uses:
- **Supabase Edge Functions** for serverless job processing
- **Shamir's Secret Sharing** for zero-knowledge API key security
- **Supabase Realtime** for live job progress updates
- **COPPA/GDPR compliant** data handling

## Prerequisites

1. **Supabase CLI** installed
2. **Linked Supabase project**
3. **OpenRouter API key**

## Step 1: Install Supabase CLI

```bash
# Install globally
npm install -g supabase

# Or use npx
npx supabase --version
```

## Step 2: Login and Link Project

```bash
# Login to Supabase
supabase login

# Navigate to project directory
cd SimpleSim

# Link to your project
supabase link --project-ref ouvrecllkqtwbtrwyhgw
```

## Step 3: Run Database Migration

```bash
# Push the migration
supabase db push

# Or run manually in SQL Editor
# Copy contents of supabase/migrations/003_jobs_and_security.sql
```

## Step 4: Set Environment Secrets

Go to **Supabase Dashboard → Edge Functions → Secrets** and add:

```bash
# Generate secure secrets (run in terminal)
openssl rand -hex 32  # For API_KEY_ENCRYPTION_SECRET
openssl rand -hex 32  # For SESSION_ENCRYPTION_SECRET
openssl rand -hex 16  # For CRON_SECRET
```

Required secrets:
- `API_KEY_ENCRYPTION_SECRET` - 64-character hex string for key encryption
- `SESSION_ENCRYPTION_SECRET` - 64-character hex string for session encryption
- `CRON_SECRET` - (Optional) Secret for validating cron requests

## Step 5: Deploy Edge Functions

```bash
# Deploy all functions
supabase functions deploy store-api-key
supabase functions deploy unlock-session
supabase functions deploy process-job
supabase functions deploy job-scheduler
```

## Step 6: Enable Realtime

In Supabase Dashboard:
1. Go to **Database → Replication**
2. Enable replication for the `jobs` table
3. Verify `supabase_realtime` publication includes `jobs`

## Step 7: Set Up Cron (Optional but Recommended)

The job scheduler needs to run periodically. Options:

### Option A: Supabase Database Webhooks (Recommended)
1. Create a database function that triggers process-job
2. Use pg_cron extension if available

### Option B: External Cron Service (Free)
Use [cron-job.org](https://cron-job.org) or similar:
- URL: `https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler`
- Method: GET
- Interval: Every 10 seconds
- Add header: `x-cron-secret: YOUR_CRON_SECRET`

### Option C: Vercel Cron (If using Vercel)
Add to `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/trigger-jobs",
      "schedule": "*/1 * * * *"
    }
  ]
}
```

## How It Works

### Security Model (Zero-Knowledge)

1. **Key Splitting**: When user saves their API key:
   - Key is split into 2 shares using Shamir's Secret Sharing
   - Share A: Encrypted with server secret, stored in database
   - Share B: Encrypted with user's PIN, stored in browser

2. **Session Unlock**: When user enters PIN:
   - Share B is decrypted locally
   - Both shares sent to server, combined temporarily
   - Full key encrypted with session key, stored in `active_sessions`
   - Session expires after 2 hours

3. **Job Processing**: Background job processor:
   - Reads encrypted key from active session
   - Decrypts with session secret
   - Calls OpenRouter API
   - Key is never logged or stored permanently

### Job Flow

```
User submits prompt → Job created in database →
User can close browser →
Scheduler picks up job → Retrieves session key →
Calls OpenRouter → Saves result →
User returns → Sees completed version
```

## Testing

1. **Configure Server Key**:
   - Go to Settings
   - Click "Enable Background Jobs"
   - Enter OpenRouter API key and 8-digit PIN

2. **Submit Test Job**:
   - Type a prompt and send
   - Job progress UI should appear
   - Shows "You can close this tab"

3. **Verify Background Execution**:
   - Close browser/tab
   - Wait for job to complete (check Supabase logs)
   - Return to app - should see completed version

## Troubleshooting

### "No active session" error
- Session expired (2-hour limit)
- Click "Unlock Session" and enter PIN

### "API key not found" error
- Server key not configured
- Go to Settings → Enable Background Jobs

### Jobs not processing
- Check Edge Function logs in Supabase Dashboard
- Verify cron is running
- Check secrets are set correctly

### "Key reconstruction failed" error
- Share B corrupted (localStorage cleared?)
- Need to re-configure server key

## Security Considerations

1. **Never expose secrets** - Keep environment variables secure
2. **Use strong PINs** - Minimum 8 digits for server keys
3. **Monitor sessions** - Sessions auto-expire after 2 hours
4. **Audit logs** - All key operations are logged (anonymized)

## COPPA/GDPR Compliance

- **Training opt-out**: Enabled by default
- **Child accounts**: Parent key delegation system
- **Data retention**: Minimal, anonymized logging
- **Right to deletion**: Clear local shares to remove key

## Files Created

```
supabase/
  migrations/
    003_jobs_and_security.sql    # Database schema
  functions/
    _shared/
      crypto.ts                   # Shamir's + AES
      supabase.ts                 # Client utilities
      security-headers.ts         # CSP + headers
    store-api-key/
      index.ts                    # Key sharding endpoint
    unlock-session/
      index.ts                    # Session management
    process-job/
      index.ts                    # Job processor
    job-scheduler/
      index.ts                    # Cron scheduler

job-queue.js                      # Client-side module
```

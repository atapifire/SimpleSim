# Deploy Edge Functions to Supabase

The Edge Functions have been fixed and committed. To deploy them, follow ONE of these options:

## Option 1: GitHub Actions (Automated - Recommended)

This sets up automatic deployment whenever you push changes to main.

### Step 1: Get Supabase Access Token
1. Go to https://supabase.com/dashboard/account/tokens
2. Click "Generate new token"
3. Name it "GitHub Actions Deploy"
4. Copy the token (starts with `sbp_`)

### Step 2: Add GitHub Secret
1. Go to your GitHub repo: https://github.com/atapifire/SimpleSim
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `SUPABASE_ACCESS_TOKEN`
5. Value: Paste your token
6. Click **Add secret**

### Step 3: Trigger Deployment
1. Go to **Actions** tab in your GitHub repo
2. Click **Deploy Edge Functions** workflow
3. Click **Run workflow** → **Run workflow**

The functions will be deployed automatically!

---

## Option 2: Manual CLI Deployment

If you prefer to deploy locally:

```bash
# Install Supabase CLI if needed
npm install -g supabase

# Login to Supabase
supabase login

# Deploy all functions
supabase functions deploy job-scheduler --project-ref ouvrecllkqtwbtrwyhgw
supabase functions deploy process-job --project-ref ouvrecllkqtwbtrwyhgw
supabase functions deploy store-api-key --project-ref ouvrecllkqtwbtrwyhgw
supabase functions deploy unlock-session --project-ref ouvrecllkqtwbtrwyhgw
```

---

## Option 3: Supabase Dashboard (Quick but Manual)

Deploy each function through the web UI:

1. Go to https://supabase.com/dashboard/project/ouvrecllkqtwbtrwyhgw/functions
2. For each function (`job-scheduler`, `process-job`, `store-api-key`, `unlock-session`):
   - Click on the function name
   - Click the **Code** tab
   - Replace the code with the contents from `supabase/functions/<function-name>/index.ts`
   - Click **Deploy**

---

## Verify Deployment

After deploying, test the job scheduler:

```bash
curl -X GET 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler' \
  -H 'Authorization: Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY'
```

You should see detailed error messages if something fails, instead of silent failures.

---

## What Was Fixed

1. **process-job** now properly handles pending jobs when a jobId is passed
2. **job-scheduler** now passes jobId for all jobs (not just resumed ones)
3. **job-scheduler** checks the response body for errors, not just HTTP status
4. Added detailed logging to debug session/API key issues

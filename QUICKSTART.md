# SimpleSim Quickstart Guide

Get SimpleSim running in under 30 minutes.

## Prerequisites

- Node.js 18+ installed
- GitHub account
- Supabase account (free): https://supabase.com
- Vercel account (free): https://vercel.com

---

## Step 1: Set Up Supabase (10 min)

### 1.1 Create Project
1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click "New Project"
3. Name it `simplesim`
4. Choose a region close to your users
5. Wait for project to be ready (~2 min)

### 1.2 Run Database Migration
1. Go to SQL Editor in your Supabase dashboard
2. Copy contents of `supabase/migrations/001_initial_schema.sql`
3. Paste and run

### 1.3 Enable GitHub OAuth
1. **In GitHub:**
   - Go to Settings > Developer settings > OAuth Apps > New OAuth App
   - Application name: `SimpleSim`
   - Homepage URL: `http://localhost:3000` (update later for production)
   - Authorization callback URL: `https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback`
   - Click "Register application"
   - Copy Client ID
   - Generate and copy Client Secret

2. **In Supabase:**
   - Go to Authentication > Providers > GitHub
   - Enable GitHub
   - Paste Client ID and Client Secret
   - Save

### 1.4 Get API Keys
1. Go to Settings > API
2. Copy:
   - Project URL (for `VITE_SUPABASE_URL`)
   - `anon` public key (for `VITE_SUPABASE_ANON_KEY`)
   - `service_role` secret (for `SUPABASE_SERVICE_ROLE_KEY`)

---

## Step 2: Local Development Setup (5 min)

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Edit .env with your Supabase credentials
# VITE_SUPABASE_URL=https://your-project.supabase.co
# VITE_SUPABASE_ANON_KEY=your-anon-key
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Start development server
npm run dev
```

Open http://localhost:3000

---

## Step 3: Deploy to Vercel (5 min)

### 3.1 Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:YOUR_USERNAME/simplesim.git
git push -u origin main
```

### 3.2 Deploy on Vercel
1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repository
3. Add Environment Variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Click Deploy

### 3.3 Update OAuth Callback
1. Go to GitHub OAuth App settings
2. Update Homepage URL to your Vercel domain
3. Update Authorization callback URL to:
   `https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback`

---

## Step 4: Test Your Setup

1. Open your deployed site
2. Click "Sign in with GitHub"
3. Authorize the app
4. Create a new project
5. Enter a prompt like "Create a landing page for a coffee shop"
6. Check that a GitHub repo was created

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     USER'S BROWSER                       │
│  ┌─────────────────────────────────────────────────────│
│  │ SimpleSim Frontend                                   │
│  │ - UI renders in browser                              │
│  │ - API keys stored encrypted in localStorage          │
│  │ - Direct calls to OpenRouter/HuggingFace (BYOK)     │
│  └─────────────────────────────────────────────────────│
└──────────────┬───────────────────────┬─────────────────┘
               │                       │
               ▼                       ▼
┌──────────────────────┐    ┌─────────────────────────────┐
│      SUPABASE        │    │         VERCEL              │
│  - PostgreSQL DB     │    │  - Static hosting           │
│  - GitHub OAuth      │    │  - API routes for GitHub    │
│  - Row Level Security│    │    (uses user's token)      │
│  - User profiles     │    │                             │
└──────────────────────┘    └─────────────────────────────┘
               │
               ▼
┌──────────────────────┐
│    AI PROVIDERS      │
│  (User's Own Keys)   │
│  - OpenRouter        │
│  - HuggingFace       │
└──────────────────────┘
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/supabase.js` | Supabase client, auth helpers |
| `src/lib/projects.js` | Project/version CRUD operations |
| `src/lib/ai-providers.js` | OpenRouter & HuggingFace clients |
| `api/github/commit.js` | Vercel function to commit to GitHub |
| `api/github/create-repo.js` | Vercel function to create repos |

---

## User Flow

1. **Sign Up:** User signs in with GitHub OAuth
2. **Create Project:** New project = new GitHub repo
3. **Enter Prompt:** User describes what they want
4. **AI Generates:** Using user's OpenRouter/HuggingFace keys
5. **Auto Commit:** Every generation auto-commits to GitHub
6. **Version History:** Full Git history for all changes

---

## Monthly Costs

| Users | Supabase | Vercel | Total |
|-------|----------|--------|-------|
| 1-100 | $0 | $0 | **$0** |
| 100-1000 | $0 | $0 | **$0** |
| 1000+ | $25 | $20 | $45 |

---

## Next Steps

After basic setup works:

1. **Add Image Generation**
   - Use `generateImage()` from `ai-providers.js`
   - Store images in Supabase Storage or as base64

2. **Add TTS**
   - Use `generateSpeech()` from `ai-providers.js`
   - Play audio or save to project

3. **Improve UI**
   - Add loading states
   - Better error handling
   - Mobile responsiveness

4. **Add Collaboration**
   - Supabase has built-in realtime
   - Can add shared editing later

# SimpleSim MVP Architecture Plan

## Executive Summary

Transform SimpleSim from a WebSim-dependent frontend into a standalone, self-hosted platform where users bring their own API keys (BYOK) for AI generation. All projects sync automatically with GitHub, providing built-in version control.

**Cost to Start: $0/month** (within free tier limits)

---

## Recommended Architecture

### Stack Decision: Supabase + Vercel

```
┌────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  SimpleSim SPA (Vanilla JS / Future: React/Vue)          │  │
│  │  - User's API keys stored encrypted in localStorage      │  │
│  │  - Direct calls to OpenRouter/HuggingFace (BYOK)         │  │
│  │  - Supabase client for auth & data                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Supabase      │  │   Vercel        │  │  External APIs  │
│   (Free Tier)   │  │   (Free Tier)   │  │  (User's Keys)  │
│                 │  │                 │  │                 │
│ - PostgreSQL    │  │ - Static Host   │  │ - OpenRouter    │
│ - GitHub OAuth  │  │ - API Routes    │  │ - HuggingFace   │
│ - Auto REST API │  │   for GitHub    │  │ - (Direct from  │
│ - Row Security  │  │   operations    │  │    browser)     │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### Why This Stack?

| Requirement | Solution |
|-------------|----------|
| **BYOK (no server keys)** | API keys stay in browser, encrypted in localStorage. Direct client-side calls to OpenRouter/HuggingFace |
| **GitHub Auth** | Supabase built-in GitHub OAuth (5 min setup) |
| **Git Integration** | Vercel API routes proxy to GitHub API using user's OAuth token |
| **PostgreSQL** | Supabase (500MB free) |
| **Zero Cost** | Both platforms have generous free tiers |
| **Small User Base** | Free tiers support ~1000 MAU easily |

---

## What Gets Removed (WebSim Dependencies)

### 1. `state.js` - WebsimSocket
```javascript
// REMOVE
export const room = new WebsimSocket();

// REPLACE WITH
import { createClient } from '@supabase/supabase-js'
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
```

### 2. `ai.js` - websim.chat.completions
```javascript
// REMOVE (lines 51-56)
const completion = await websim.chat.completions.create({
    messages: messages,
    json: true
});

// KEEP - Already has OpenRouter support, just make it the default
```

### 3. `projects.js` - All WebsimSocket collections
```javascript
// REMOVE
room.collection('project').subscribe()
room.collection('version').create()

// REPLACE WITH
supabase.from('projects').select()
supabase.from('versions').insert()
```

---

## Database Schema (PostgreSQL via Supabase)

```sql
-- Users (auto-managed by Supabase Auth, extended with profile)
CREATE TABLE profiles (
    id UUID REFERENCES auth.users PRIMARY KEY,
    github_username TEXT NOT NULL,
    github_access_token TEXT, -- Encrypted, for GitHub API calls
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects (linked to GitHub repos)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    github_repo TEXT, -- "username/repo-name"
    github_default_branch TEXT DEFAULT 'main',
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Versions (synced with Git commits)
CREATE TABLE versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    files JSONB NOT NULL, -- [{path, content}, ...]
    description TEXT, -- Commit message
    git_commit_sha TEXT, -- Links to actual Git commit
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security (users only see their own data)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON profiles
    FOR ALL USING (auth.uid() = id);

CREATE POLICY "Users can view own projects" ON projects
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can view versions of own projects" ON versions
    FOR ALL USING (
        project_id IN (
            SELECT id FROM projects WHERE user_id = auth.uid()
        )
    );
```

---

## BYOK Implementation

### Key Storage (Client-Side Only)
The existing `security.js` implementation is excellent. Keep it:
- PIN-protected encryption (AES-GCM)
- 30-minute auto-lock
- Keys never leave the browser

### Supported Providers

#### 1. OpenRouter (Text Generation)
```javascript
// Already partially implemented in ai.js
// User provides: OPENROUTER_API_KEY

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        model: selectedModel,
        messages: [...],
    })
});
```

**Supported Models via OpenRouter:**
- Claude 3.5 Sonnet, Claude 3 Opus
- GPT-4o, GPT-4 Turbo
- Gemini Pro, Gemini Ultra
- Llama 3, Mistral, etc.

#### 2. HuggingFace (Images, TTS, Custom Models)
```javascript
// User provides: HF_API_KEY

// Image Generation (Stable Diffusion, FLUX, etc.)
const response = await fetch(
    'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
    {
        headers: { Authorization: `Bearer ${userHfKey}` },
        body: JSON.stringify({ inputs: prompt })
    }
);
const imageBlob = await response.blob();

// Text-to-Speech
const ttsResponse = await fetch(
    'https://api-inference.huggingface.co/models/facebook/mms-tts-eng',
    {
        headers: { Authorization: `Bearer ${userHfKey}` },
        body: JSON.stringify({ inputs: text })
    }
);
const audioBlob = await ttsResponse.blob();
```

### Settings UI Updates
Extend existing settings modal to include:
- OpenRouter API Key (existing)
- HuggingFace API Key (new)
- Model selection for each capability:
  - Code generation model
  - Image generation model
  - TTS model

---

## GitHub Integration

### Authentication Flow
```
1. User clicks "Sign in with GitHub"
2. Supabase redirects to GitHub OAuth
3. GitHub asks for permissions:
   - repo (full control of private repos)
   - user:email (read email)
4. User approves, redirected back
5. Supabase stores OAuth token
6. Token saved to profiles.github_access_token (encrypted)
```

### Auto-Git Operations

Every project save triggers:
```javascript
async function saveVersion(project, files, prompt, description) {
    // 1. Save to database
    const { data: version } = await supabase
        .from('versions')
        .insert({ project_id: project.id, files, prompt, description })
        .select()
        .single();

    // 2. Commit to GitHub (via Vercel API route)
    const commitSha = await fetch('/api/github/commit', {
        method: 'POST',
        body: JSON.stringify({
            repo: project.github_repo,
            files: files,
            message: description || `Update: ${prompt.slice(0, 50)}...`
        })
    });

    // 3. Update version with commit SHA
    await supabase
        .from('versions')
        .update({ git_commit_sha: commitSha })
        .eq('id', version.id);
}
```

### Vercel API Route: `/api/github/commit.js`
```javascript
import { createClient } from '@supabase/supabase-js'
import { Octokit } from '@octokit/rest'

export default async function handler(req, res) {
    // Get user's GitHub token from Supabase
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    const { data: { user } } = await supabase.auth.getUser(
        req.headers.authorization?.replace('Bearer ', '')
    );

    const { data: profile } = await supabase
        .from('profiles')
        .select('github_access_token')
        .eq('id', user.id)
        .single();

    // Use user's token to commit
    const octokit = new Octokit({ auth: profile.github_access_token });

    // Create/update files and commit
    // ... GitHub API operations
}
```

---

## Free Tier Limits & Scaling

### Supabase Free Tier
| Resource | Limit | Typical Usage |
|----------|-------|---------------|
| Database | 500 MB | ~50,000 projects |
| Auth Users | 50,000 MAU | More than enough |
| API Requests | Unlimited | - |
| Realtime | 200 concurrent | - |

### Vercel Free Tier
| Resource | Limit | Typical Usage |
|----------|-------|---------------|
| Bandwidth | 100 GB/mo | ~100K visits |
| Serverless | 150K invocations | ~5K users × 30 saves |
| Build Time | 6,000 min/mo | - |

### When to Upgrade
- Supabase Pro ($25/mo): More than 500 daily active users
- Vercel Pro ($20/mo): More than 100K monthly visits

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [ ] Set up Supabase project
  - [ ] Create database schema
  - [ ] Configure GitHub OAuth
  - [ ] Set up Row Level Security
- [ ] Set up Vercel project
  - [ ] Deploy current static site
  - [ ] Add Supabase client
- [ ] Remove WebSim dependencies
  - [ ] Replace WebsimSocket with Supabase client
  - [ ] Remove websim.chat references
  - [ ] Update state.js

### Phase 2: Authentication (Week 2)
- [ ] Implement GitHub OAuth flow
  - [ ] Login/logout buttons
  - [ ] Auth state management
  - [ ] Protected routes
- [ ] Create profile management
  - [ ] Store GitHub username
  - [ ] Handle token refresh
- [ ] Update UI for auth states

### Phase 3: Project Management (Week 2-3)
- [ ] Replace project CRUD with Supabase
- [ ] Replace version CRUD with Supabase
- [ ] Add GitHub repo creation on new project
- [ ] Implement auto-commit on save
- [ ] Version history from Git commits

### Phase 4: BYOK AI Integration (Week 3)
- [ ] Keep OpenRouter integration (already exists)
- [ ] Add HuggingFace client
- [ ] Add image generation capability
- [ ] Add TTS capability
- [ ] Settings UI for all API keys

### Phase 5: Polish (Week 4)
- [ ] Error handling and loading states
- [ ] Mobile responsiveness
- [ ] Onboarding flow
- [ ] Documentation

---

## File Structure After Migration

```
SimpleSim/
├── index.html              # Entry point
├── styles.css              # Existing styles
├── src/
│   ├── main.js             # App initialization
│   ├── state.js            # Supabase client + global state
│   ├── auth.js             # GitHub OAuth handling
│   ├── ai/
│   │   ├── openrouter.js   # OpenRouter API client
│   │   ├── huggingface.js  # HuggingFace API client
│   │   └── index.js        # AI provider facade
│   ├── github/
│   │   └── client.js       # GitHub operations (via API routes)
│   ├── projects/
│   │   ├── manager.js      # Project CRUD
│   │   └── versions.js     # Version management
│   ├── security/
│   │   ├── encryption.js   # Key encryption (existing)
│   │   └── modal.js        # PIN modal (existing)
│   └── ui/
│       ├── settings.js     # Settings modal
│       ├── renderer.js     # Preview iframe
│       └── utils.js        # Toast, loading, etc.
├── api/                    # Vercel serverless functions
│   └── github/
│       ├── commit.js       # Create commit
│       ├── create-repo.js  # Create new repo
│       └── sync.js         # Sync project with repo
├── supabase/
│   └── migrations/
│       └── 001_initial.sql # Database schema
└── package.json            # Dependencies
```

---

## Dependencies to Add

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.x",
    "@octokit/rest": "^20.x"
  },
  "devDependencies": {
    "vite": "^5.x"
  }
}
```

**Notes:**
- Vite for local development (hot reload) and production builds
- Keep the app lightweight - no heavy frameworks needed for MVP
- Can add React/Vue later if complexity grows

---

## Security Considerations

1. **API Keys (BYOK)**
   - Never sent to our servers
   - Encrypted in localStorage with user's PIN
   - Direct browser-to-provider communication

2. **GitHub Token**
   - Stored encrypted in Supabase (server-side)
   - Used only for Git operations via API routes
   - Minimal scope: `repo`, `user:email`

3. **Row Level Security**
   - All database tables have RLS enabled
   - Users can only access their own data
   - Enforced at database level

4. **CORS & API Routes**
   - All GitHub operations go through Vercel API routes
   - User tokens never exposed to client
   - Rate limiting via Vercel

---

## Alternative Considerations

### If Supabase Pausing is Concerning
Use **Neon + NextAuth** instead:
- Neon scales to zero (no pausing)
- NextAuth handles GitHub OAuth
- Slightly more code required

### If Need Real-Time Collaboration Later
- Supabase has built-in realtime
- Can add collaborative editing
- Consider Yjs or Liveblocks for CRDT

### If Need Custom Backend Logic
- Migrate API routes to **Fly.io**
- Still free within $5 credit
- More control, persistent connections

---

## Summary

This MVP architecture achieves:
- **$0/month** hosting cost (within free tiers)
- **BYOK model** - users bring OpenRouter/HuggingFace keys
- **GitHub-native** - all projects are Git repos with full history
- **Minimal backend** - Supabase handles auth/DB, Vercel handles Git operations
- **Scalable** - can grow to thousands of users before needing paid tiers

The migration preserves the existing PIN-based encryption and UI patterns while replacing the WebSim dependencies with open, self-hostable alternatives.

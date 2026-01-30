#!/bin/bash
# SimpleSim Edge Functions Deployment Script
#
# Prerequisites:
# 1. Install Supabase CLI: npm install -g supabase
# 2. Login to Supabase: supabase login
#
# Usage: ./scripts/deploy-functions.sh

set -e

PROJECT_REF="ouvrecllkqtwbtrwyhgw"

echo "🚀 Deploying SimpleSim Edge Functions..."
echo ""

# Check if supabase CLI is available
if ! command -v supabase &> /dev/null; then
    echo "❌ Supabase CLI not found. Install with: npm install -g supabase"
    exit 1
fi

# Check if logged in
if ! supabase projects list &>/dev/null; then
    echo "❌ Not logged in to Supabase. Please run: supabase login"
    exit 1
fi

echo "✅ Supabase CLI authenticated"
echo ""

# Deploy all functions with --no-verify-jwt
# This allows both user JWTs and service_role key to work
# Without this flag, the built-in JWT verification rejects valid tokens

echo "📦 Deploying store-api-key..."
supabase functions deploy store-api-key --project-ref $PROJECT_REF --no-verify-jwt

echo ""
echo "📦 Deploying unlock-session..."
supabase functions deploy unlock-session --project-ref $PROJECT_REF --no-verify-jwt

echo ""
echo "📦 Deploying process-job..."
supabase functions deploy process-job --project-ref $PROJECT_REF --no-verify-jwt

echo ""
echo "📦 Deploying job-scheduler..."
supabase functions deploy job-scheduler --project-ref $PROJECT_REF --no-verify-jwt

echo ""
echo "✅ All functions deployed successfully!"
echo ""
echo "Next steps:"
echo "1. Enable pg_cron in Supabase Dashboard -> Database -> Extensions"
echo "2. Run migrations: supabase db push --project-ref $PROJECT_REF"
echo "3. Verify GitHub Actions has SUPABASE_SERVICE_ROLE_KEY secret set"
echo ""
echo "To test the scheduler manually:"
echo "curl -X GET 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler' \\"
echo "  -H 'Authorization: Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY'"

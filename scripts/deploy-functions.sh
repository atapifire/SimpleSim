#!/bin/bash

# Deploy Supabase Edge Functions
# Run this script after logging in with `supabase login`

echo "=== Deploying Supabase Edge Functions ==="

# Check if supabase CLI is available
if ! command -v supabase &> /dev/null; then
    echo "Error: Supabase CLI not found. Install with: npm install -g supabase"
    exit 1
fi

# Check if logged in
if ! supabase projects list &> /dev/null; then
    echo "Error: Not logged in. Run: supabase login"
    exit 1
fi

PROJECT_REF="ouvrecllkqtwbtrwyhgw"

echo ""
echo "Deploying job-scheduler..."
supabase functions deploy job-scheduler --project-ref $PROJECT_REF

echo ""
echo "Deploying process-job..."
supabase functions deploy process-job --project-ref $PROJECT_REF

echo ""
echo "Deploying store-api-key..."
supabase functions deploy store-api-key --project-ref $PROJECT_REF

echo ""
echo "Deploying unlock-session..."
supabase functions deploy unlock-session --project-ref $PROJECT_REF

echo ""
echo "=== Deployment complete! ==="
echo ""
echo "To test manually, run:"
echo "curl -X GET 'https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler' \\"
echo "  -H 'Authorization: Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY'"

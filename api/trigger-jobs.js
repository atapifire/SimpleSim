/**
 * Vercel Cron Handler - Triggers Job Scheduler
 *
 * This endpoint is called by Vercel Cron every minute to process pending jobs.
 * It invokes the Supabase Edge Function job-scheduler.
 */

const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
const JOB_SCHEDULER_URL = `${SUPABASE_URL}/functions/v1/job-scheduler`;

export default async function handler(request) {
    // Only allow GET (cron) or POST
    if (request.method !== 'GET' && request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Verify this is a cron request (Vercel sets this header)
    const isVercelCron = request.headers.get('x-vercel-cron') === '1';
    const authHeader = request.headers.get('authorization');

    // Allow if it's a Vercel cron or has valid auth
    if (!isVercelCron && !authHeader) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        // Build headers for Supabase call
        const headers = {
            'Content-Type': 'application/json'
        };

        // Pass through any cron secret if configured
        if (process.env.CRON_SECRET) {
            headers['x-cron-secret'] = process.env.CRON_SECRET;
        }

        // Use service role key for elevated permissions
        if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
            headers['Authorization'] = `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
        }

        // Call the Supabase Edge Function
        const response = await fetch(JOB_SCHEDULER_URL, {
            method: 'GET',
            headers
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Job scheduler error:', data);
            return new Response(JSON.stringify(data), {
                status: response.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({
            success: true,
            timestamp: new Date().toISOString(),
            ...data
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Trigger jobs error:', error);
        return new Response(JSON.stringify({
            error: 'Failed to trigger job scheduler',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export const config = {
    runtime: 'edge'
};

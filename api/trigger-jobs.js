/**
 * Vercel Cron Handler - Triggers Job Scheduler
 *
 * This endpoint is called by Vercel Cron every minute to process pending jobs.
 * It invokes the Supabase Edge Function job-scheduler.
 */

const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
const JOB_SCHEDULER_URL = `${SUPABASE_URL}/functions/v1/job-scheduler`;

export default async function handler(req, res) {
    // Only allow GET (cron) or POST
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Verify this is a cron request (Vercel sets this header)
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = req.headers['authorization'];

    // Allow if it's a Vercel cron or has valid auth
    if (!isVercelCron && !authHeader) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Call the Supabase Edge Function
        const response = await fetch(JOB_SCHEDULER_URL, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                // Pass through any cron secret if configured
                ...(process.env.CRON_SECRET && {
                    'x-cron-secret': process.env.CRON_SECRET
                }),
                // Use service role key for elevated permissions
                ...(process.env.SUPABASE_SERVICE_ROLE_KEY && {
                    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
                })
            }
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Job scheduler error:', data);
            return res.status(response.status).json(data);
        }

        return res.status(200).json({
            success: true,
            timestamp: new Date().toISOString(),
            ...data
        });

    } catch (error) {
        console.error('Trigger jobs error:', error);
        return res.status(500).json({
            error: 'Failed to trigger job scheduler',
            message: error.message
        });
    }
}

// Configure for Vercel serverless
export const config = {
    runtime: 'edge', // Use edge for faster cold starts
};

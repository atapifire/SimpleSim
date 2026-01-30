/**
 * Vercel Serverless Function: Trigger Job Scheduler
 *
 * This endpoint can be called to process pending background jobs.
 * It invokes the Supabase Edge Function job-scheduler.
 */

const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';
const JOB_SCHEDULER_URL = `${SUPABASE_URL}/functions/v1/job-scheduler`;

export default async function handler(req, res) {
    // Only allow GET or POST
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Check for authorization
    const authHeader = req.headers['authorization'];
    const cronSecret = req.headers['x-cron-secret'];

    // Allow if has valid auth or matching cron secret
    const validCronSecret = process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET;
    if (!authHeader && !validCronSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Build headers for Supabase call
        const headers = {
            'Content-Type': 'application/json'
        };

        // Pass through cron secret if configured
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

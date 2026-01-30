/**
 * Job Scheduler Edge Function
 *
 * Cron-triggered scheduler that:
 * 1. Checks for pending jobs
 * 2. Invokes process-job for each pending job
 * 3. Resumes interrupted agent jobs
 * 4. Cleans up expired jobs and sessions
 *
 * Designed to be called every 5-10 seconds via Supabase scheduled functions
 * or an external cron service (e.g., Vercel Cron, cron-job.org)
 */

import {
  createServiceClient,
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/supabase.ts';

// Configuration
const MAX_CONCURRENT_JOBS = 5;
const PROCESS_JOB_URL = Deno.env.get('SUPABASE_URL') + '/functions/v1/process-job';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Accept GET (for simple cron) or POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // Optional: Verify cron secret for security
  const cronSecret = req.headers.get('x-cron-secret');
  const expectedSecret = Deno.env.get('CRON_SECRET');
  if (expectedSecret && cronSecret !== expectedSecret) {
    // Log but don't reject - might be internal call
    console.log('Cron secret mismatch or missing');
  }

  const serviceClient = createServiceClient();
  const results = {
    pendingJobsFound: 0,
    jobsStarted: 0,
    jobsResumed: 0,
    expiredCleaned: 0,
    errors: [] as string[],
  };

  try {
    // 1. Cleanup expired sessions and jobs
    const { data: cleanupCount } = await serviceClient.rpc('cleanup_expired');
    results.expiredCleaned = cleanupCount || 0;

    // 2. Check for pending jobs
    const { data: pendingJobs, error: pendingError } = await serviceClient
      .from('jobs')
      .select('id, user_id, job_type, created_at')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(MAX_CONCURRENT_JOBS);

    if (pendingError) {
      console.error('Error fetching pending jobs:', pendingError);
      results.errors.push('Failed to fetch pending jobs');
    }

    results.pendingJobsFound = pendingJobs?.length || 0;

    // 3. Check for stalled processing jobs (need resumption)
    const { data: stalledJobs, error: stalledError } = await serviceClient
      .from('jobs')
      .select('id, user_id, job_type, current_iteration, last_heartbeat')
      .eq('status', 'processing')
      .eq('job_type', 'agent')
      .lt('last_heartbeat', new Date(Date.now() - 60000).toISOString()) // 1 min no heartbeat
      .limit(MAX_CONCURRENT_JOBS);

    if (stalledError) {
      console.error('Error fetching stalled jobs:', stalledError);
      results.errors.push('Failed to fetch stalled jobs');
    }

    // 4. Check that users have active sessions before starting their jobs
    const allJobsToProcess = [
      ...(pendingJobs || []).map(j => ({ ...j, isResume: false })),
      ...(stalledJobs || []).map(j => ({ ...j, isResume: true })),
    ];

    for (const job of allJobsToProcess) {
      // Verify user has active session
      const { data: session } = await serviceClient
        .from('active_sessions')
        .select('id')
        .eq('user_id', job.user_id)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (!session) {
        console.log(`Skipping job ${job.id} - user has no active session`);
        continue;
      }

      // Invoke process-job function
      try {
        const response = await fetch(PROCESS_JOB_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            jobId: job.isResume ? job.id : undefined,
          }),
        });

        if (response.ok) {
          if (job.isResume) {
            results.jobsResumed++;
            console.log(`Resumed agent job ${job.id} at iteration ${job.current_iteration}`);
          } else {
            results.jobsStarted++;
            console.log(`Started job ${job.id} (${job.job_type})`);
          }
        } else {
          const errorText = await response.text();
          console.error(`Failed to process job ${job.id}:`, errorText);
          results.errors.push(`Job ${job.id}: ${errorText}`);
        }
      } catch (invokeError) {
        console.error(`Error invoking process-job for ${job.id}:`, invokeError);
        results.errors.push(`Job ${job.id}: ${invokeError.message}`);
      }
    }

    // 5. Log scheduler run
    await serviceClient.from('audit_log').insert({
      user_id: null,
      event_type: 'scheduler_run',
      event_category: 'system',
      details: results,
    });

    return jsonResponse({
      success: true,
      ...results,
    });

  } catch (error) {
    console.error('Scheduler error:', error);
    return errorResponse('Scheduler failed: ' + error.message, 500);
  }
});

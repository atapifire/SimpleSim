/**
 * Job System Diagnostic Script
 *
 * Paste this into the browser console to diagnose job processing issues.
 * Make sure you're logged in and on the SimpleSim app page.
 */

(async function diagnoseJobs() {
    console.log('=== SimpleSim Job System Diagnostics ===\n');

    // Import state and supabase from the app
    const { state, supabase } = await import('./state.js');

    // 1. Check Authentication
    console.log('1. AUTHENTICATION');
    console.log('   User ID:', state.user?.id || 'NOT LOGGED IN');
    console.log('   Session present:', !!state.session);
    console.log('   Has access token:', !!state.session?.access_token);
    console.log('');

    // 2. Check Server Key Configuration
    console.log('2. SERVER KEY CONFIGURATION');
    console.log('   Share B stored locally:', !!localStorage.getItem('simplesim_share_b'));
    console.log('   Session unlocked:', state.sessionUnlocked);
    console.log('   Server API key in memory:', !!state.serverApiKey);
    console.log('   Session expires at:', state.sessionExpiresAt || 'N/A');
    console.log('');

    // 3. Check Active Sessions in Database
    console.log('3. ACTIVE SESSIONS (Database)');
    if (state.user) {
        const { data: sessions, error } = await supabase
            .from('active_sessions')
            .select('id, expires_at, created_at')
            .eq('user_id', state.user.id);

        if (error) {
            console.log('   Error:', error.message);
        } else if (sessions?.length > 0) {
            sessions.forEach((s, i) => {
                const isActive = new Date(s.expires_at) > new Date();
                console.log(`   Session ${i + 1}: expires ${s.expires_at} (${isActive ? 'ACTIVE' : 'EXPIRED'})`);
            });
        } else {
            console.log('   No sessions found');
        }
    } else {
        console.log('   (Login required)');
    }
    console.log('');

    // 4. Check Jobs
    console.log('4. JOBS');
    if (state.user) {
        const { data: jobs, error } = await supabase
            .from('jobs')
            .select('id, status, job_type, created_at, started_at, completed_at, error_message, current_iteration, max_iterations')
            .eq('user_id', state.user.id)
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) {
            console.log('   Error:', error.message);
        } else if (jobs?.length > 0) {
            jobs.forEach((job, i) => {
                console.log(`   Job ${i + 1}:`);
                console.log(`     ID: ${job.id}`);
                console.log(`     Status: ${job.status}`);
                console.log(`     Type: ${job.job_type}`);
                console.log(`     Created: ${job.created_at}`);
                console.log(`     Started: ${job.started_at || 'NOT STARTED'}`);
                console.log(`     Completed: ${job.completed_at || 'NOT COMPLETED'}`);
                if (job.job_type === 'agent') {
                    console.log(`     Iterations: ${job.current_iteration}/${job.max_iterations}`);
                }
                if (job.error_message) {
                    console.log(`     ERROR: ${job.error_message}`);
                }
                console.log('');
            });
        } else {
            console.log('   No jobs found');
        }
    } else {
        console.log('   (Login required)');
    }

    // 5. Current App State
    console.log('5. CURRENT APP STATE');
    console.log('   Project ID:', state.projectId || 'None');
    console.log('   Is generating:', state.isGenerating);
    console.log('   Current job:', state.currentJob?.id || 'None');
    console.log('   Use background jobs:', state.settings.useBackgroundJobs);
    console.log('   Has server key setting:', state.settings.hasServerKey);
    console.log('');

    // 6. Realtime Subscription Test
    console.log('6. TESTING REALTIME SUBSCRIPTION');
    if (state.currentJob) {
        console.log(`   Subscribing to job ${state.currentJob.id}...`);
        const channel = supabase
            .channel(`test-job:${state.currentJob.id}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'jobs',
                    filter: `id=eq.${state.currentJob.id}`
                },
                (payload) => {
                    console.log('   [REALTIME] Job update received:', payload.new?.status);
                }
            )
            .subscribe((status) => {
                console.log('   [REALTIME] Subscription status:', status);
            });

        // Clean up after 10 seconds
        setTimeout(() => {
            channel.unsubscribe();
            console.log('   [REALTIME] Test subscription closed');
        }, 10000);
    } else {
        console.log('   No current job to subscribe to');
    }

    console.log('\n=== End Diagnostics ===');
    console.log('\nTo manually trigger the scheduler, run:');
    console.log('fetch("https://ouvrecllkqtwbtrwyhgw.supabase.co/functions/v1/job-scheduler", { method: "GET", headers: { "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY" } }).then(r => r.json()).then(console.log)');

    return {
        userId: state.user?.id,
        sessionUnlocked: state.sessionUnlocked,
        hasServerApiKey: !!state.serverApiKey,
        currentJobId: state.currentJob?.id
    };
})();

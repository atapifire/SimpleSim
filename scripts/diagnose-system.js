/**
 * SimpleSim System Diagnostic Tool
 *
 * Run in browser console to diagnose issues:
 * 1. Copy and paste this entire file into browser console
 * 2. Run: runDiagnostics()
 *
 * Or import and run programmatically.
 */

const SUPABASE_URL = 'https://ouvrecllkqtwbtrwyhgw.supabase.co';

async function runDiagnostics() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           SimpleSim System Diagnostics                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('Timestamp:', new Date().toISOString());
    console.log('');

    const results = {
        auth: null,
        session: null,
        apiKey: null,
        jobs: null,
        edge: null,
        summary: []
    };

    // 1. Check Auth State
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 1. Authentication Check                                     │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    try {
        if (typeof window !== 'undefined' && window.state) {
            const state = window.state;
            console.log('✓ State object available');
            console.log('  User ID:', state.user?.id || 'NOT SET');
            console.log('  User Email:', state.user?.email || 'NOT SET');
            console.log('  Profile:', state.profile ? 'SET' : 'NOT SET');
            console.log('  Session:', state.session ? 'SET' : 'NOT SET');

            if (state.session?.access_token) {
                console.log('  Access Token: SET (length:', state.session.access_token.length, ')');

                // Decode token
                try {
                    const payload = JSON.parse(atob(state.session.access_token.split('.')[1]));
                    const exp = new Date(payload.exp * 1000);
                    const now = new Date();
                    console.log('  Token User ID:', payload.sub);
                    console.log('  Token Expires:', exp.toISOString());
                    console.log('  Token Expired:', now > exp ? 'YES ⚠️' : 'NO ✓');
                    console.log('  Time Until Expiry:', Math.round((exp - now) / 1000 / 60), 'minutes');

                    results.auth = {
                        status: now > exp ? 'EXPIRED' : 'OK',
                        userId: payload.sub,
                        expiresAt: exp.toISOString()
                    };
                } catch (e) {
                    console.log('  ⚠️ Failed to decode token:', e.message);
                    results.auth = { status: 'INVALID_TOKEN', error: e.message };
                }
            } else {
                console.log('  ⚠️ No access token in session');
                results.auth = { status: 'NO_TOKEN' };
            }
        } else {
            console.log('⚠️ State object not available (not in browser context)');
            results.auth = { status: 'NO_STATE' };
        }
    } catch (e) {
        console.error('✗ Auth check failed:', e.message);
        results.auth = { status: 'ERROR', error: e.message };
    }

    // 2. Check Session Status
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 2. Background Job Session Check                             │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    try {
        if (typeof window !== 'undefined' && window.state) {
            const state = window.state;
            console.log('  Session Unlocked:', state.sessionUnlocked ? 'YES ✓' : 'NO ⚠️');
            console.log('  Session Expires At:', state.sessionExpiresAt?.toISOString() || 'NOT SET');
            console.log('  Server API Key in Memory:', state.serverApiKey ? 'YES ✓' : 'NO');

            if (state.sessionExpiresAt) {
                const remaining = state.sessionExpiresAt.getTime() - Date.now();
                console.log('  Session Time Remaining:', Math.round(remaining / 1000 / 60), 'minutes');
                results.session = {
                    status: remaining > 0 ? 'ACTIVE' : 'EXPIRED',
                    expiresAt: state.sessionExpiresAt.toISOString(),
                    remainingMinutes: Math.round(remaining / 1000 / 60)
                };
            } else {
                results.session = { status: 'NO_SESSION' };
            }

            // Check localStorage for Share B
            const shareB = localStorage.getItem('simplesim_share_b');
            console.log('  Local Share B:', shareB ? 'SET ✓' : 'NOT SET ⚠️');
            if (!shareB) {
                results.summary.push('⚠️ No local Share B - need to configure API key');
            }
        }
    } catch (e) {
        console.error('✗ Session check failed:', e.message);
        results.session = { status: 'ERROR', error: e.message };
    }

    // 3. Check Database Session
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 3. Database Session Check                                   │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    try {
        if (typeof window !== 'undefined' && window.supabase && window.state?.user) {
            const { data: sessions, error } = await window.supabase
                .from('active_sessions')
                .select('id, expires_at, device_fingerprint, created_at')
                .eq('user_id', window.state.user.id)
                .order('created_at', { ascending: false })
                .limit(5);

            if (error) {
                console.log('  ⚠️ Could not query sessions:', error.message);
            } else if (!sessions || sessions.length === 0) {
                console.log('  ⚠️ No active sessions in database');
                results.summary.push('⚠️ No active sessions - need to unlock');
            } else {
                console.log('  Found', sessions.length, 'session(s):');
                for (const session of sessions) {
                    const exp = new Date(session.expires_at);
                    const now = new Date();
                    const status = now > exp ? '❌ EXPIRED' : '✓ ACTIVE';
                    console.log(`    ${status} - Created: ${session.created_at}, Expires: ${session.expires_at}`);
                }

                const activeSessions = sessions.filter(s => new Date(s.expires_at) > new Date());
                if (activeSessions.length === 0) {
                    results.summary.push('⚠️ All database sessions expired - need to unlock');
                }
            }
        } else {
            console.log('  Skipped (not in browser context or no user)');
        }
    } catch (e) {
        console.error('✗ Database session check failed:', e.message);
    }

    // 4. Check API Key Configuration
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 4. API Key Configuration Check                              │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    try {
        if (typeof window !== 'undefined' && window.supabase && window.state?.user) {
            const { data: keys, error } = await window.supabase
                .from('api_keys')
                .select('id, provider, is_server_encrypted, key_label, created_at')
                .eq('user_id', window.state.user.id);

            if (error) {
                console.log('  ⚠️ Could not query API keys:', error.message);
            } else if (!keys || keys.length === 0) {
                console.log('  ⚠️ No API keys configured');
                results.summary.push('⚠️ No API keys configured - need to add key in settings');
                results.apiKey = { status: 'NOT_CONFIGURED' };
            } else {
                console.log('  Found', keys.length, 'API key(s):');
                for (const key of keys) {
                    console.log(`    - ${key.provider}: ${key.key_label || 'Unlabeled'}`);
                    console.log(`      Server Encrypted: ${key.is_server_encrypted ? 'YES ✓' : 'NO ⚠️'}`);
                    console.log(`      Created: ${key.created_at}`);
                }
                results.apiKey = { status: 'CONFIGURED', count: keys.length };
            }
        } else {
            console.log('  Skipped (not in browser context or no user)');
        }
    } catch (e) {
        console.error('✗ API key check failed:', e.message);
        results.apiKey = { status: 'ERROR', error: e.message };
    }

    // 5. Check Recent Jobs
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 5. Recent Jobs Check                                        │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    try {
        if (typeof window !== 'undefined' && window.supabase && window.state?.user) {
            const { data: jobs, error } = await window.supabase
                .from('jobs')
                .select('id, status, job_type, error_message, created_at, started_at, completed_at')
                .eq('user_id', window.state.user.id)
                .order('created_at', { ascending: false })
                .limit(10);

            if (error) {
                console.log('  ⚠️ Could not query jobs:', error.message);
            } else if (!jobs || jobs.length === 0) {
                console.log('  No jobs found');
            } else {
                console.log('  Recent jobs:');
                const statusEmoji = {
                    'pending': '🕐',
                    'processing': '⚙️',
                    'completed': '✅',
                    'failed': '❌',
                    'cancelled': '🚫'
                };
                for (const job of jobs) {
                    const emoji = statusEmoji[job.status] || '❓';
                    console.log(`    ${emoji} ${job.status.padEnd(10)} - ${job.job_type} - ${job.created_at}`);
                    if (job.error_message) {
                        console.log(`       Error: ${job.error_message}`);
                    }
                }

                // Check for common issues
                const failedJobs = jobs.filter(j => j.status === 'failed');
                if (failedJobs.length > 0) {
                    const errorMessages = [...new Set(failedJobs.map(j => j.error_message).filter(Boolean))];
                    console.log('\n  Common error messages:');
                    for (const msg of errorMessages) {
                        console.log(`    - ${msg}`);
                    }

                    // Diagnose specific errors
                    if (errorMessages.some(m => m.includes('User not found'))) {
                        results.summary.push('⚠️ "User not found" error - likely OpenRouter API key issue');
                        results.summary.push('   → Check if API key is valid at openrouter.ai');
                        results.summary.push('   → Try re-saving your API key in settings');
                    }
                    if (errorMessages.some(m => m.includes('No active session'))) {
                        results.summary.push('⚠️ Session expired - need to unlock with PIN');
                    }
                }

                results.jobs = {
                    total: jobs.length,
                    failed: failedJobs.length,
                    pending: jobs.filter(j => j.status === 'pending').length,
                    processing: jobs.filter(j => j.status === 'processing').length
                };
            }
        } else {
            console.log('  Skipped (not in browser context or no user)');
        }
    } catch (e) {
        console.error('✗ Jobs check failed:', e.message);
    }

    // 6. Check Edge Functions
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 6. Edge Function Health Check                               │');
    console.log('└─────────────────────────────────────────────────────────────┘');

    try {
        // Check unlock-session endpoint (GET returns version info)
        const unlockResponse = await fetch(`${SUPABASE_URL}/functions/v1/unlock-session`, {
            method: 'GET'
        });
        const unlockData = await unlockResponse.json();
        console.log('  unlock-session:');
        console.log('    Status:', unlockResponse.status);
        console.log('    Version:', unlockData.version || 'unknown');
        console.log('    Env Check:', JSON.stringify(unlockData.envCheck || {}));

        results.edge = {
            unlockSession: {
                status: unlockResponse.status,
                version: unlockData.version
            }
        };
    } catch (e) {
        console.error('✗ Edge function check failed:', e.message);
        results.edge = { status: 'ERROR', error: e.message };
    }

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    DIAGNOSTIC SUMMARY                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    if (results.summary.length === 0) {
        console.log('✓ No issues detected');
    } else {
        console.log('Issues found:');
        for (const issue of results.summary) {
            console.log('  ' + issue);
        }
    }

    console.log('\nRecommended Actions:');
    if (results.auth?.status === 'EXPIRED' || results.auth?.status === 'NO_TOKEN') {
        console.log('  1. Refresh the page to get a new auth token');
    }
    if (results.session?.status !== 'ACTIVE') {
        console.log('  2. Click "Unlock Session" and enter your PIN');
    }
    if (results.apiKey?.status === 'NOT_CONFIGURED') {
        console.log('  3. Go to Settings and add your OpenRouter API key');
    }
    if (results.summary.some(s => s.includes('User not found'))) {
        console.log('  4. Verify your OpenRouter API key is valid at https://openrouter.ai/keys');
        console.log('  5. Re-save your API key in Settings to regenerate shares');
    }

    console.log('\n═══════════════════════════════════════════════════════════════');

    return results;
}

// Quick check function
async function quickCheck() {
    console.log('Quick System Check...\n');

    const checks = {
        'Auth Token': () => !!window.state?.session?.access_token,
        'User ID': () => !!window.state?.user?.id,
        'Session Unlocked': () => !!window.state?.sessionUnlocked,
        'Local Share B': () => !!localStorage.getItem('simplesim_share_b'),
        'Server API Key': () => !!window.state?.serverApiKey
    };

    let allPassed = true;
    for (const [name, check] of Object.entries(checks)) {
        try {
            const passed = check();
            console.log(`  ${passed ? '✓' : '✗'} ${name}`);
            if (!passed) allPassed = false;
        } catch (e) {
            console.log(`  ✗ ${name} (error: ${e.message})`);
            allPassed = false;
        }
    }

    console.log(allPassed ? '\n✓ All checks passed' : '\n⚠️ Some checks failed - run runDiagnostics() for details');
    return allPassed;
}

// Export for use in browser
if (typeof window !== 'undefined') {
    window.runDiagnostics = runDiagnostics;
    window.quickCheck = quickCheck;
    console.log('Diagnostic tools loaded. Run:');
    console.log('  quickCheck()     - Fast system check');
    console.log('  runDiagnostics() - Full diagnostic report');
}

export { runDiagnostics, quickCheck };

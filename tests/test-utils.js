/**
 * SimpleSim Test Utilities
 *
 * Provides test helpers for unit and integration testing
 */

// Test result tracking
const testResults = {
    passed: 0,
    failed: 0,
    skipped: 0,
    results: []
};

/**
 * Assert helper
 */
export function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

/**
 * Assert equals
 */
export function assertEquals(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected} but got ${actual}`);
    }
}

/**
 * Assert truthy
 */
export function assertTruthy(value, message) {
    if (!value) {
        throw new Error(message || `Expected truthy value but got ${value}`);
    }
}

/**
 * Assert throws
 */
export async function assertThrows(fn, expectedError, message) {
    try {
        await fn();
        throw new Error(message || 'Expected function to throw');
    } catch (error) {
        if (expectedError && !error.message.includes(expectedError)) {
            throw new Error(`Expected error containing "${expectedError}" but got "${error.message}"`);
        }
    }
}

/**
 * Run a test with error handling
 */
export async function runTest(name, testFn) {
    const startTime = Date.now();
    try {
        await testFn();
        const duration = Date.now() - startTime;
        testResults.passed++;
        testResults.results.push({ name, status: 'passed', duration });
        console.log(`✓ ${name} (${duration}ms)`);
        return { success: true, duration };
    } catch (error) {
        const duration = Date.now() - startTime;
        testResults.failed++;
        testResults.results.push({ name, status: 'failed', error: error.message, duration });
        console.error(`✗ ${name} (${duration}ms)`);
        console.error(`  Error: ${error.message}`);
        return { success: false, error: error.message, duration };
    }
}

/**
 * Skip a test
 */
export function skipTest(name, reason) {
    testResults.skipped++;
    testResults.results.push({ name, status: 'skipped', reason });
    console.log(`○ ${name} (skipped: ${reason})`);
}

/**
 * Run a test suite
 */
export async function runSuite(suiteName, tests) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Test Suite: ${suiteName}`);
    console.log('='.repeat(50));

    const suiteStart = Date.now();
    const results = [];

    for (const [name, testFn] of Object.entries(tests)) {
        if (typeof testFn === 'function') {
            results.push(await runTest(name, testFn));
        }
    }

    const suiteDuration = Date.now() - suiteStart;
    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`\nSuite completed in ${suiteDuration}ms: ${passed} passed, ${failed} failed`);

    return { suiteName, passed, failed, duration: suiteDuration, results };
}

/**
 * Get final test summary
 */
export function getTestSummary() {
    return {
        ...testResults,
        total: testResults.passed + testResults.failed + testResults.skipped
    };
}

/**
 * Print final test summary
 */
export function printSummary() {
    const summary = getTestSummary();
    console.log(`\n${'='.repeat(50)}`);
    console.log('FINAL TEST SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed}`);
    console.log(`Failed:  ${summary.failed}`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log('='.repeat(50));

    if (summary.failed > 0) {
        console.log('\nFailed tests:');
        summary.results
            .filter(r => r.status === 'failed')
            .forEach(r => console.log(`  - ${r.name}: ${r.error}`));
    }

    return summary;
}

/**
 * Mock fetch for testing
 */
export function createMockFetch(responses) {
    let callIndex = 0;
    return async (url, options) => {
        const response = responses[callIndex] || responses[responses.length - 1];
        callIndex++;
        return {
            ok: response.ok !== false,
            status: response.status || 200,
            json: async () => response.json || {},
            text: async () => response.text || JSON.stringify(response.json || {}),
            clone: function() { return this; }
        };
    };
}

/**
 * Wait helper
 */
export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a test HTML document
 */
export function createTestHtml(content = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
    ${content}
</body>
</html>`;
}

export default {
    assert,
    assertEquals,
    assertTruthy,
    assertThrows,
    runTest,
    skipTest,
    runSuite,
    getTestSummary,
    printSummary,
    createMockFetch,
    wait,
    createTestHtml
};

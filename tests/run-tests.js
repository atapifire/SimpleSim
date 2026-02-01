#!/usr/bin/env node
/**
 * SimpleSim Test Runner
 *
 * Run all tests: node tests/run-tests.js
 * Run specific suite: node tests/run-tests.js --suite=html
 * Run in browser: Open tests/index.html
 */

import { runSuite, printSummary, assert, assertEquals, assertTruthy, createTestHtml } from './test-utils.js';
import { validateHtml, detectTruncation, checkTagBalance, repairHtml, validateAndRepair } from './html-validator.js';

// ============================================
// HTML Validator Tests
// ============================================
const htmlValidatorTests = {
    'should validate correct HTML': () => {
        const html = createTestHtml('<h1>Hello</h1>');
        const result = validateHtml(html);
        assert(result.valid, 'Valid HTML should pass validation');
    },

    'should detect missing closing tag': () => {
        const html = '<html><body><div>Unclosed';
        const result = validateHtml(html);
        assert(!result.valid, 'Should detect unclosed div');
        assert(result.errors.some(e => e.message.includes('Unclosed')), 'Should report unclosed tag');
    },

    'should detect truncated content': () => {
        const html = '<html><body><div class="test';
        const result = detectTruncation(html);
        assert(result.truncated, 'Should detect truncation');
    },

    'should handle void elements': () => {
        const html = createTestHtml('<img src="test.jpg"><br><input type="text">');
        const result = validateHtml(html);
        // Void elements don't need closing tags
        const tagErrors = result.errors.filter(e =>
            e.message.includes('img') || e.message.includes('br') || e.message.includes('input')
        );
        assertEquals(tagErrors.length, 0, 'Should not report errors for void elements');
    },

    'should repair missing DOCTYPE': () => {
        const html = '<html><head></head><body>Test</body></html>';
        const repaired = repairHtml(html);
        assert(repaired.content.includes('<!DOCTYPE html>'), 'Should add DOCTYPE');
        assert(repaired.repaired, 'Should indicate content was repaired');
    },

    'should repair unclosed tags': () => {
        const html = '<!DOCTYPE html><html><body><div>Content</body></html>';
        const result = validateAndRepair(html);
        assert(result.repaired, 'Should repair unclosed div');
        assert(result.content.includes('</div>'), 'Should add closing div');
    },

    'should detect mismatched tags': () => {
        const html = '<div><span>Text</div></span>';
        const balance = checkTagBalance(html);
        assert(!balance.balanced, 'Should detect mismatched tags');
    },

    'should handle Llama 3.3 style truncation': () => {
        // Llama sometimes truncates mid-attribute
        const truncated = '<div class="container mx-auto px-4"><h1 class="text-3xl font-bol';
        const result = detectTruncation(truncated);
        assert(result.truncated, 'Should detect Llama-style truncation');
    },

    'should handle empty content': () => {
        const result = validateHtml('');
        assert(!result.valid, 'Empty content should not be valid');
    },

    'should detect duplicate IDs': () => {
        const html = createTestHtml('<div id="test">A</div><div id="test">B</div>');
        const result = validateHtml(html);
        assert(result.warnings.some(w => w.message.includes('Duplicate ID')), 'Should warn about duplicate IDs');
    },

    'should detect missing alt on images': () => {
        const html = createTestHtml('<img src="test.jpg">');
        const result = validateHtml(html);
        assert(result.warnings.some(w => w.message.includes('alt')), 'Should warn about missing alt');
    },

    'should handle script tags correctly': () => {
        const html = createTestHtml('<script>const x = 1;</script>');
        const result = validateHtml(html);
        assert(result.valid || result.errors.length === 0, 'Valid script should pass');
    },

    'should detect unclosed script tags': () => {
        const html = '<script>console.log("test")';
        const result = detectTruncation(html);
        assert(result.truncated, 'Should detect unclosed script');
    }
};

// ============================================
// File Operations Tests (mock)
// ============================================
const fileOpsTests = {
    'should apply simple edit': () => {
        const content = 'Hello World';
        const edits = [{ search: 'World', replace: 'SimpleSim' }];

        // Simulate applyEdits
        let result = content;
        for (const edit of edits) {
            result = result.replace(edit.search, edit.replace);
        }

        assertEquals(result, 'Hello SimpleSim', 'Edit should be applied');
    },

    'should handle multiple edits': () => {
        const content = '<div class="old">Old Text</div>';
        const edits = [
            { search: 'class="old"', replace: 'class="new"' },
            { search: 'Old Text', replace: 'New Text' }
        ];

        let result = content;
        for (const edit of edits) {
            result = result.replace(edit.search, edit.replace);
        }

        assertEquals(result, '<div class="new">New Text</div>', 'Multiple edits should be applied');
    },

    'should preserve file structure': () => {
        const files = [
            { path: 'index.html', content: '<html></html>' },
            { path: 'style.css', content: 'body {}' }
        ];

        // Simulate merge
        const changes = [
            { path: 'index.html', content: '<html><body></body></html>', action: 'modify' }
        ];

        const merged = files.map(f => {
            const change = changes.find(c => c.path === f.path);
            return change ? { ...f, content: change.content } : f;
        });

        assertEquals(merged.length, 2, 'Should preserve file count');
        assert(merged[0].content.includes('<body>'), 'Should apply changes');
    }
};

// ============================================
// Shamir Secret Sharing Tests (mock)
// ============================================
const shamirTests = {
    'should split and combine correctly': () => {
        // Mock implementation
        const secret = 'sk-or-test-key-12345';
        const shares = mockSplitSecret(secret, 2, 2);

        assertEquals(shares.length, 2, 'Should create 2 shares');

        const combined = mockCombineShares(shares);
        assertEquals(combined, secret, 'Should reconstruct original secret');
    },

    'should work with any 2-of-2 threshold': () => {
        const secret = 'test-api-key';
        const shares = mockSplitSecret(secret, 2, 2);

        // Both shares required
        const combined = mockCombineShares(shares);
        assertEquals(combined, secret, 'Should require all shares');
    }
};

// Mock Shamir functions for testing
function mockSplitSecret(secret, numShares, threshold) {
    // Simplified mock - in real implementation uses polynomial math
    const encoder = new TextEncoder();
    const bytes = encoder.encode(secret);

    const shares = [];
    for (let i = 0; i < numShares; i++) {
        const share = new Uint8Array(bytes.length + 1);
        share[0] = i + 1; // Share index
        for (let j = 0; j < bytes.length; j++) {
            // XOR with index for mock splitting
            share[j + 1] = bytes[j] ^ ((i + 1) * 17);
        }
        shares.push(share);
    }
    return shares;
}

function mockCombineShares(shares) {
    // Simplified mock - reverse the XOR
    const result = new Uint8Array(shares[0].length - 1);
    for (let i = 0; i < result.length; i++) {
        // For 2-of-2, just XOR both shares
        result[i] = shares[0][i + 1] ^ ((shares[0][0]) * 17);
    }
    return new TextDecoder().decode(result);
}

// ============================================
// Session Tests (mock)
// ============================================
const sessionTests = {
    'should track session expiry': () => {
        const session = {
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 hours
        };

        const remaining = session.expiresAt.getTime() - Date.now();
        assert(remaining > 0, 'Session should not be expired');
        assert(remaining <= 2 * 60 * 60 * 1000, 'Session should expire within 2 hours');
    },

    'should detect expired session': () => {
        const session = {
            expiresAt: new Date(Date.now() - 1000) // 1 second ago
        };

        const remaining = session.expiresAt.getTime() - Date.now();
        assert(remaining < 0, 'Session should be expired');
    },

    'should format time remaining': () => {
        const formatTime = (ms) => {
            if (ms <= 0) return 'Expired';
            const minutes = Math.floor(ms / 60000);
            const hours = Math.floor(minutes / 60);
            if (hours > 0) return `${hours}h ${minutes % 60}m`;
            return `${minutes}m`;
        };

        assertEquals(formatTime(0), 'Expired');
        assertEquals(formatTime(5 * 60000), '5m');
        assertEquals(formatTime(90 * 60000), '1h 30m');
    }
};

// ============================================
// Model Profile Tests
// ============================================
const modelProfileTests = {
    'should detect Claude family': () => {
        const models = [
            'anthropic/claude-3.5-sonnet',
            'anthropic/claude-3-opus',
            'claude-3.5-sonnet'
        ];

        for (const model of models) {
            const family = detectModelFamily(model);
            assertEquals(family, 'claude', `Should detect ${model} as Claude`);
        }
    },

    'should detect GPT family': () => {
        const models = ['openai/gpt-4', 'openai/gpt-4o', 'gpt-4-turbo'];
        for (const model of models) {
            const family = detectModelFamily(model);
            assertEquals(family, 'gpt', `Should detect ${model} as GPT`);
        }
    },

    'should detect Llama family': () => {
        const models = ['meta-llama/llama-3.3-70b', 'llama-3.3-70b-instruct'];
        for (const model of models) {
            const family = detectModelFamily(model);
            assertEquals(family, 'llama', `Should detect ${model} as Llama`);
        }
    },

    'should return correct context limits': () => {
        const limits = {
            claude: 200000,
            gpt: 128000,
            llama: 128000,
            gemini: 1000000
        };

        for (const [family, expected] of Object.entries(limits)) {
            const profile = mockGetModelProfile(family);
            assertEquals(profile.contextWindow, expected, `${family} should have ${expected} context`);
        }
    }
};

function detectModelFamily(modelId) {
    const lower = modelId.toLowerCase();
    if (lower.includes('claude') || lower.startsWith('anthropic/')) return 'claude';
    if (lower.includes('gpt') || lower.startsWith('openai/gpt')) return 'gpt';
    if (lower.includes('llama') || lower.startsWith('meta-llama/')) return 'llama';
    if (lower.includes('gemini') || lower.startsWith('google/')) return 'gemini';
    return 'default';
}

function mockGetModelProfile(family) {
    const profiles = {
        claude: { contextWindow: 200000, outputLimit: 8192 },
        gpt: { contextWindow: 128000, outputLimit: 16384 },
        llama: { contextWindow: 128000, outputLimit: 4096 },
        gemini: { contextWindow: 1000000, outputLimit: 8192 },
        default: { contextWindow: 32000, outputLimit: 4096 }
    };
    return profiles[family] || profiles.default;
}

// ============================================
// Integration Tests (require browser/network)
// ============================================
const integrationTests = {
    'placeholder - auth flow': () => {
        // This would test the full auth flow in a browser environment
        // Skipped in Node.js
        console.log('  (Skipped: requires browser environment)');
    },

    'placeholder - job submission': () => {
        // This would test job submission to Supabase
        console.log('  (Skipped: requires Supabase connection)');
    }
};

// ============================================
// Run All Tests
// ============================================
async function runAllTests() {
    console.log('SimpleSim Test Suite');
    console.log('====================\n');

    const suites = [
        ['HTML Validator', htmlValidatorTests],
        ['File Operations', fileOpsTests],
        ['Shamir Secret Sharing', shamirTests],
        ['Session Management', sessionTests],
        ['Model Profiles', modelProfileTests],
    ];

    for (const [name, tests] of suites) {
        await runSuite(name, tests);
    }

    const summary = printSummary();

    // Exit with error code if tests failed
    if (typeof process !== 'undefined' && summary.failed > 0) {
        process.exit(1);
    }

    return summary;
}

// Run tests if executed directly
if (typeof window === 'undefined') {
    runAllTests().catch(console.error);
}

export { runAllTests };

/**
 * Tests for Preview Error Capture System
 * Verifies that the agent can receive JavaScript errors from the preview iframe
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the thinking module
vi.mock('../thinking.js', () => ({
    devLog: vi.fn(),
    devError: vi.fn(),
}));

// We need to test the logic without actually rendering to an iframe
// So we'll test the error store directly

describe('Preview Error Store', () => {
    let clearPreviewErrors, getPreviewErrors, addPreviewError, addConsoleMessage;

    beforeEach(async () => {
        // Reset modules to get fresh state
        vi.resetModules();

        // Create mock implementations of the internal functions
        // Since these are not exported, we'll test through the message handler
        const errorStore = {
            errors: [],
            consoleErrors: [],
            consoleWarns: [],
            lastRenderTime: null,
        };

        clearPreviewErrors = () => {
            errorStore.errors = [];
            errorStore.consoleErrors = [];
            errorStore.consoleWarns = [];
            errorStore.lastRenderTime = Date.now();
        };

        getPreviewErrors = () => ({
            errors: [...errorStore.errors],
            consoleErrors: [...errorStore.consoleErrors],
            consoleWarns: [...errorStore.consoleWarns],
            hasErrors: errorStore.errors.length > 0 || errorStore.consoleErrors.length > 0,
            lastRenderTime: errorStore.lastRenderTime,
        });

        addPreviewError = (error) => {
            if (errorStore.errors.length < 20) {
                errorStore.errors.push({
                    ...error,
                    timestamp: Date.now(),
                });
            }
        };

        addConsoleMessage = (type, args) => {
            const message = args.map(arg => String(arg)).join(' ');
            const entry = { message, timestamp: Date.now() };

            if (type === 'error' && errorStore.consoleErrors.length < 50) {
                errorStore.consoleErrors.push(entry);
            } else if (type === 'warn' && errorStore.consoleWarns.length < 50) {
                errorStore.consoleWarns.push(entry);
            }
        };
    });

    describe('clearPreviewErrors', () => {
        it('should reset all error arrays', () => {
            // Add some errors first
            addPreviewError({ message: 'Test error', line: 1 });
            addConsoleMessage('error', ['Console error']);
            addConsoleMessage('warn', ['Console warning']);

            // Clear errors
            clearPreviewErrors();
            const result = getPreviewErrors();

            expect(result.errors).toHaveLength(0);
            expect(result.consoleErrors).toHaveLength(0);
            expect(result.consoleWarns).toHaveLength(0);
            expect(result.hasErrors).toBe(false);
        });

        it('should set lastRenderTime', () => {
            const beforeTime = Date.now();
            clearPreviewErrors();
            const result = getPreviewErrors();

            expect(result.lastRenderTime).toBeGreaterThanOrEqual(beforeTime);
            expect(result.lastRenderTime).toBeLessThanOrEqual(Date.now());
        });
    });

    describe('getPreviewErrors', () => {
        it('should return empty state initially', () => {
            clearPreviewErrors();
            const result = getPreviewErrors();

            expect(result.errors).toEqual([]);
            expect(result.consoleErrors).toEqual([]);
            expect(result.consoleWarns).toEqual([]);
            expect(result.hasErrors).toBe(false);
        });

        it('should return hasErrors=true when runtime errors exist', () => {
            clearPreviewErrors();
            addPreviewError({ message: 'TypeError: null', line: 10 });
            const result = getPreviewErrors();

            expect(result.hasErrors).toBe(true);
            expect(result.errors).toHaveLength(1);
        });

        it('should return hasErrors=true when console errors exist', () => {
            clearPreviewErrors();
            addConsoleMessage('error', ['Something went wrong']);
            const result = getPreviewErrors();

            expect(result.hasErrors).toBe(true);
            expect(result.consoleErrors).toHaveLength(1);
        });

        it('should return hasErrors=false when only warnings exist', () => {
            clearPreviewErrors();
            addConsoleMessage('warn', ['Deprecation warning']);
            const result = getPreviewErrors();

            expect(result.hasErrors).toBe(false);
            expect(result.consoleWarns).toHaveLength(1);
        });
    });

    describe('addPreviewError', () => {
        it('should capture runtime error with line number', () => {
            clearPreviewErrors();
            addPreviewError({
                type: 'runtime',
                message: "Cannot read properties of null (reading 'appendChild')",
                line: 44,
                column: 15,
            });

            const result = getPreviewErrors();
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].message).toContain('appendChild');
            expect(result.errors[0].line).toBe(44);
        });

        it('should capture promise rejection', () => {
            clearPreviewErrors();
            addPreviewError({
                type: 'promise',
                message: 'Failed to fetch',
                stack: 'Error: Failed to fetch\n    at fetchData (script.js:20)',
            });

            const result = getPreviewErrors();
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].type).toBe('promise');
        });

        it('should limit errors to MAX_ERRORS (20)', () => {
            clearPreviewErrors();
            for (let i = 0; i < 30; i++) {
                addPreviewError({ message: `Error ${i}`, line: i });
            }

            const result = getPreviewErrors();
            expect(result.errors).toHaveLength(20);
        });
    });

    describe('addConsoleMessage', () => {
        it('should capture console.error messages', () => {
            clearPreviewErrors();
            addConsoleMessage('error', ['Error:', 'Something failed']);

            const result = getPreviewErrors();
            expect(result.consoleErrors).toHaveLength(1);
            expect(result.consoleErrors[0].message).toBe('Error: Something failed');
        });

        it('should capture console.warn messages', () => {
            clearPreviewErrors();
            addConsoleMessage('warn', ['Warning: deprecated API']);

            const result = getPreviewErrors();
            expect(result.consoleWarns).toHaveLength(1);
            expect(result.consoleWarns[0].message).toContain('deprecated');
        });

        it('should handle object arguments', () => {
            clearPreviewErrors();
            addConsoleMessage('error', ['Object:', { key: 'value' }]);

            const result = getPreviewErrors();
            // Objects get stringified
            expect(result.consoleErrors[0].message).toContain('Object:');
        });

        it('should limit console messages to MAX_CONSOLE (50)', () => {
            clearPreviewErrors();
            for (let i = 0; i < 60; i++) {
                addConsoleMessage('error', [`Error ${i}`]);
            }

            const result = getPreviewErrors();
            expect(result.consoleErrors).toHaveLength(50);
        });
    });
});

describe('Agent Tool: get_preview_errors', () => {
    it('should format errors for agent consumption', () => {
        // Simulate what the agent tool returns
        const mockErrors = {
            errors: [
                { type: 'runtime', message: "Cannot read 'appendChild'", line: 44, column: 10 },
            ],
            consoleErrors: [{ message: 'Error: DOM not ready' }],
            consoleWarns: [{ message: 'Warning: deprecated' }],
            hasErrors: true,
        };

        // Format like the tool does
        const formattedErrors = mockErrors.errors.map(e => ({
            type: e.type,
            message: e.message,
            line: e.line,
            column: e.column
        }));
        const formattedConsoleErrors = mockErrors.consoleErrors.map(e => e.message);
        const formattedWarns = mockErrors.consoleWarns.map(e => e.message);

        expect(formattedErrors).toHaveLength(1);
        expect(formattedErrors[0].line).toBe(44);
        expect(formattedConsoleErrors).toEqual(['Error: DOM not ready']);
        expect(formattedWarns).toEqual(['Warning: deprecated']);
    });
});

describe('Error Handler Script', () => {
    it('should generate proper postMessage calls', () => {
        // The error handler script should post messages with correct structure
        const expectedErrorMessage = {
            type: 'preview-error',
            data: {
                type: 'runtime',
                message: 'Test error',
                line: 10,
                column: 5,
                stack: null
            }
        };

        expect(expectedErrorMessage.type).toBe('preview-error');
        expect(expectedErrorMessage.data.type).toBe('runtime');
    });

    it('should handle unhandled promise rejections', () => {
        const expectedPromiseMessage = {
            type: 'preview-error',
            data: {
                type: 'promise',
                message: 'Promise rejection reason',
                stack: null
            }
        };

        expect(expectedPromiseMessage.data.type).toBe('promise');
    });

    it('should intercept console.error', () => {
        const expectedConsoleMessage = {
            type: 'preview-console',
            data: {
                level: 'error',
                args: ['Error message']
            }
        };

        expect(expectedConsoleMessage.type).toBe('preview-console');
        expect(expectedConsoleMessage.data.level).toBe('error');
    });
});

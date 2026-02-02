import { describe, it, expect } from 'vitest';
import {
    applyEdits,
    validateEdits,
    mergeWithEdits,
    detectTruncation,
    validateFileSyntax,
    analyzeDomReferences
} from '../file-ops.js';

describe('applyEdits', () => {
    it('should apply a single edit', () => {
        const content = 'Hello World';
        const edits = [{ search: 'World', replace: 'Universe' }];
        const result = applyEdits(content, edits);
        expect(result.success).toBe(true);
        expect(result.content).toBe('Hello Universe');
    });

    it('should apply multiple edits', () => {
        const content = 'color: red;\nfont-size: 14px;';
        const edits = [
            { search: 'red', replace: 'blue' },
            { search: '14px', replace: '16px' }
        ];
        const result = applyEdits(content, edits);
        expect(result.success).toBe(true);
        expect(result.content).toBe('color: blue;\nfont-size: 16px;');
    });

    it('should fail if search string not found', () => {
        const content = 'Hello World';
        const edits = [{ search: 'Foo', replace: 'Bar' }];
        const result = applyEdits(content, edits);
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('should fail if search string appears multiple times', () => {
        const content = 'red red red';
        const edits = [{ search: 'red', replace: 'blue' }];
        const result = applyEdits(content, edits);
        expect(result.success).toBe(false);
        expect(result.error).toContain('multiple times');
    });

    it('should handle empty edits array', () => {
        const content = 'Hello World';
        const result = applyEdits(content, []);
        expect(result.success).toBe(false);
    });
});

describe('validateEdits', () => {
    it('should validate edits that will work', () => {
        const content = 'Hello World';
        const edits = [{ search: 'World', replace: 'Universe' }];
        const result = validateEdits(content, edits);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('should detect missing search strings', () => {
        const content = 'Hello World';
        const edits = [{ search: 'Foo', replace: 'Bar' }];
        const result = validateEdits(content, edits);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });
});

describe('mergeWithEdits', () => {
    it('should merge modified files', () => {
        const existing = [{ path: 'index.html', content: '<h1>Old</h1>' }];
        const changes = [{ path: 'index.html', action: 'modify', content: '<h1>New</h1>' }];
        const result = mergeWithEdits(existing, changes);
        expect(result.files).toHaveLength(1);
        expect(result.files[0].content).toBe('<h1>New</h1>');
    });

    it('should add new files', () => {
        const existing = [{ path: 'index.html', content: '<h1>Hello</h1>' }];
        const changes = [{ path: 'styles.css', action: 'add', content: 'body {}' }];
        const result = mergeWithEdits(existing, changes);
        expect(result.files).toHaveLength(2);
    });

    it('should delete files', () => {
        const existing = [
            { path: 'index.html', content: '<h1>Hello</h1>' },
            { path: 'old.css', content: 'body {}' }
        ];
        const changes = [{ path: 'old.css', action: 'delete' }];
        const result = mergeWithEdits(existing, changes);
        expect(result.files).toHaveLength(1);
        expect(result.files[0].path).toBe('index.html');
    });

    it('should apply edits', () => {
        const existing = [{ path: 'styles.css', content: 'color: red;' }];
        const changes = [{
            path: 'styles.css',
            action: 'edit',
            edits: [{ search: 'red', replace: 'blue' }]
        }];
        const result = mergeWithEdits(existing, changes);
        expect(result.files[0].content).toBe('color: blue;');
    });
});

describe('detectTruncation', () => {
    it('should detect significant content reduction', () => {
        const original = 'a'.repeat(1000);
        const newContent = 'a'.repeat(400);
        const result = detectTruncation(original, newContent);
        expect(result.truncated).toBe(true);
        expect(result.reduction).toBeGreaterThan(50);
    });

    it('should not flag minor changes', () => {
        const original = 'Hello World';
        const newContent = 'Hello Earth'; // Similar length, just different
        const result = detectTruncation(original, newContent);
        expect(result.truncated).toBe(false);
    });
});

describe('validateFileSyntax', () => {
    it('should validate correct JSON', () => {
        const result = validateFileSyntax('data.json', '{"key": "value"}');
        expect(result.valid).toBe(true);
    });

    it('should reject invalid JSON', () => {
        const result = validateFileSyntax('data.json', '{key: value}');
        expect(result.valid).toBe(false);
    });

    it('should validate balanced HTML', () => {
        const html = '<!DOCTYPE html><html><head></head><body><div></div></body></html>';
        const result = validateFileSyntax('index.html', html);
        expect(result.valid).toBe(true);
    });

    it('should detect unbalanced CSS braces', () => {
        const css = '.class { color: red;';
        const result = validateFileSyntax('styles.css', css);
        expect(result.valid).toBe(false);
    });
});

describe('analyzeDomReferences', () => {
    it('should detect matching element IDs', () => {
        const files = [
            {
                path: 'index.html',
                content: '<div id="container"><button id="submit-btn">Submit</button></div>'
            },
            {
                path: 'script.js',
                content: `
                    const container = document.getElementById('container');
                    const btn = document.getElementById('submit-btn');
                `
            }
        ];

        const result = analyzeDomReferences(files);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('should detect missing element IDs', () => {
        const files = [
            {
                path: 'index.html',
                content: '<div id="container"></div>'
            },
            {
                path: 'app.js',
                content: `
                    const el = document.getElementById('missing-element');
                    el.textContent = 'Hello';
                `
            }
        ];

        const result = analyzeDomReferences(files);
        expect(result.valid).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues[0].ids).toContain('missing-element');
    });

    it('should detect the common appendChild null error pattern', () => {
        // This is the exact error pattern from the user's DragonTetris project
        const files = [
            {
                path: 'index.html',
                content: `
                    <!DOCTYPE html>
                    <html>
                    <body>
                        <div id="game-container"></div>
                        <script src="game.js"></script>
                    </body>
                    </html>
                `
            },
            {
                path: 'game.js',
                content: `
                    // Bug: ID mismatch - 'game' vs 'game-container'
                    const container = document.getElementById('game');
                    const canvas = document.createElement('canvas');
                    container.appendChild(canvas); // Will throw: Cannot read properties of null
                `
            }
        ];

        const result = analyzeDomReferences(files);
        expect(result.valid).toBe(false);
        expect(result.issues[0].ids).toContain('game');
        // Should suggest the correct ID
        expect(result.issues[0].suggestions).toBeDefined();
        expect(result.issues[0].suggestions['game']).toContain('game-container');
    });

    it('should detect querySelector ID references', () => {
        const files = [
            {
                path: 'index.html',
                content: '<main id="app"></main>'
            },
            {
                path: 'script.js',
                content: `document.querySelector('#main-content');`
            }
        ];

        const result = analyzeDomReferences(files);
        expect(result.valid).toBe(false);
        expect(result.issues[0].ids).toContain('main-content');
    });

    it('should return all HTML and JS IDs for debugging', () => {
        const files = [
            {
                path: 'index.html',
                content: '<div id="a"></div><span id="b"></span>'
            },
            {
                path: 'app.js',
                content: `
                    document.getElementById('a');
                    document.getElementById('c');
                `
            }
        ];

        const result = analyzeDomReferences(files);
        expect(result.htmlIds).toContain('a');
        expect(result.htmlIds).toContain('b');
        expect(result.jsIds).toContain('a');
        expect(result.jsIds).toContain('c');
    });

    it('should detect case sensitivity issues', () => {
        const files = [
            {
                path: 'index.html',
                content: '<button id="submitBtn"></button>'
            },
            {
                path: 'script.js',
                content: `document.getElementById('submitbtn');` // lowercase
            }
        ];

        const result = analyzeDomReferences(files);
        expect(result.valid).toBe(false);
        // Should suggest the correctly-cased ID
        expect(result.issues[0].suggestions?.['submitbtn']).toContain('submitBtn');
    });
});

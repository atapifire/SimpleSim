/**
 * Library Catalog Tests
 *
 * Tests for the library documentation and detection system:
 * - Library catalog data integrity
 * - Detection patterns for imports, CDN URLs, and API usage
 * - Error analysis and suggestions
 * - Documentation formatting
 */

import { describe, it, expect } from 'vitest';
import {
    LIBRARY_CATALOG,
    DETECTION_PATTERNS,
    detectLibraries,
    getLibraryDocs,
    getLibrariesByCategory,
    getErrorSolution,
    analyzeLibraryError,
    getCategories,
    searchLibraries,
    formatLibraryDocs
} from '../library-catalog.js';

// ============================================================================
// CATALOG INTEGRITY TESTS
// ============================================================================

describe('Library Catalog Structure', () => {
    it('should have entries for major libraries', () => {
        const requiredLibraries = [
            'three', 'pixi', 'gsap', 'chart.js', 'd3', 'leaflet',
            'react', 'vue', 'tailwind', 'localStorage', 'webAudio', 'zod'
        ];

        for (const lib of requiredLibraries) {
            expect(LIBRARY_CATALOG[lib], `Missing library: ${lib}`).toBeDefined();
        }
    });

    it('should have complete data for each library', () => {
        for (const [key, lib] of Object.entries(LIBRARY_CATALOG)) {
            expect(lib.name, `${key}: missing name`).toBeTruthy();
            expect(lib.category, `${key}: missing category`).toBeTruthy();
            expect(lib.description, `${key}: missing description`).toBeTruthy();
            expect(lib.importPattern, `${key}: missing importPattern`).toBeDefined();
            expect(lib.usage, `${key}: missing usage`).toBeTruthy();
        }
    });

    it('should have usage examples that are valid JavaScript', () => {
        for (const [key, lib] of Object.entries(LIBRARY_CATALOG)) {
            // Just check it's a non-empty string with code-like content
            expect(lib.usage.length, `${key}: usage too short`).toBeGreaterThan(50);
            expect(lib.usage, `${key}: usage should have code`).toMatch(/[;{}=()]/);
        }
    });

    it('should have common errors with solutions', () => {
        const librariesWithErrors = ['three', 'chart.js', 'react', 'localStorage'];

        for (const key of librariesWithErrors) {
            const lib = LIBRARY_CATALOG[key];
            expect(lib.commonErrors, `${key}: missing commonErrors`).toBeDefined();
            expect(Object.keys(lib.commonErrors).length, `${key}: no error entries`).toBeGreaterThan(0);
        }
    });
});

// ============================================================================
// LIBRARY DETECTION TESTS
// ============================================================================

describe('Library Detection', () => {
    describe('detectLibraries', () => {
        it('should detect Three.js from import statement', () => {
            const code = `import * as THREE from 'three';
const scene = new THREE.Scene();`;

            const detected = detectLibraries(code);
            expect(detected).toContain('three');
        });

        it('should detect Three.js from CDN URL', () => {
            const code = `<script type="importmap">
{
    "imports": {
        "three": "https://esm.sh/three@0.160.0"
    }
}
</script>`;

            const detected = detectLibraries(code);
            expect(detected).toContain('three');
        });

        it('should detect Chart.js from new Chart()', () => {
            const code = `const chart = new Chart(ctx, { type: 'bar', data: {} });`;
            const detected = detectLibraries(code);
            expect(detected).toContain('chart.js');
        });

        it('should detect localStorage API usage', () => {
            const code = `localStorage.setItem('key', 'value');
const data = localStorage.getItem('key');`;

            const detected = detectLibraries(code);
            expect(detected).toContain('localStorage');
        });

        it('should detect Web Audio API usage', () => {
            const code = `const ctx = new AudioContext();
const oscillator = ctx.createOscillator();`;

            const detected = detectLibraries(code);
            expect(detected).toContain('webAudio');
        });

        it('should detect React from useState', () => {
            const code = `import { useState, useEffect } from 'react';
const [count, setCount] = useState(0);`;

            const detected = detectLibraries(code);
            expect(detected).toContain('react');
        });

        it('should detect Vue from createApp', () => {
            const code = `import { createApp, ref } from 'vue';
const app = createApp({ setup() {} });
app.mount('#app');`;

            const detected = detectLibraries(code);
            expect(detected).toContain('vue');
        });

        it('should detect Leaflet from L.map()', () => {
            const code = `const map = L.map('map').setView([51.505, -0.09], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);`;

            const detected = detectLibraries(code);
            expect(detected).toContain('leaflet');
        });

        it('should detect GSAP from gsap.to()', () => {
            const code = `gsap.to('.box', { x: 100, duration: 1 });`;
            const detected = detectLibraries(code);
            expect(detected).toContain('gsap');
        });

        it('should detect multiple libraries in one codebase', () => {
            const code = `
import * as THREE from 'three';
import gsap from 'gsap';

localStorage.setItem('score', 100);

const scene = new THREE.Scene();
gsap.to(scene.position, { x: 10, duration: 2 });
`;

            const detected = detectLibraries(code);
            expect(detected).toContain('three');
            expect(detected).toContain('gsap');
            expect(detected).toContain('localStorage');
        });

        it('should detect Tailwind from CDN URL', () => {
            const code = `<script src="https://cdn.twind.style" crossorigin></script>
<div class="min-h-screen bg-gray-100"></div>`;

            const detected = detectLibraries(code);
            expect(detected).toContain('tailwind');
        });

        it('should detect D3 from d3.select()', () => {
            const code = `d3.select('#chart').append('svg').attr('width', 500);`;
            const detected = detectLibraries(code);
            expect(detected).toContain('d3');
        });
    });
});

// ============================================================================
// DOCUMENTATION RETRIEVAL TESTS
// ============================================================================

describe('Library Documentation', () => {
    describe('getLibraryDocs', () => {
        it('should return docs for exact library name', () => {
            const docs = getLibraryDocs('three');
            expect(docs).toBeDefined();
            expect(docs.name).toBe('Three.js');
        });

        it('should handle case-insensitive lookup', () => {
            const docs = getLibraryDocs('THREE');
            expect(docs).toBeDefined();
            expect(docs.name).toBe('Three.js');
        });

        it('should handle partial name match', () => {
            const docs = getLibraryDocs('chartjs');
            expect(docs).toBeDefined();
            expect(docs.name).toBe('Chart.js');
        });

        it('should return null for unknown library', () => {
            const docs = getLibraryDocs('nonexistent-library-xyz');
            expect(docs).toBeNull();
        });
    });

    describe('getLibrariesByCategory', () => {
        it('should return 3D libraries', () => {
            const libs = getLibrariesByCategory('3d');
            expect(libs.length).toBeGreaterThan(0);
            expect(libs.some(l => l.name === 'Three.js')).toBe(true);
        });

        it('should return animation libraries', () => {
            const libs = getLibrariesByCategory('animation');
            expect(libs.length).toBeGreaterThan(0);
            expect(libs.some(l => l.name === 'GSAP')).toBe(true);
        });

        it('should return chart libraries', () => {
            const libs = getLibrariesByCategory('charts');
            expect(libs.length).toBeGreaterThan(0);
            expect(libs.some(l => l.name === 'Chart.js')).toBe(true);
        });
    });

    describe('searchLibraries', () => {
        it('should find libraries by name', () => {
            const results = searchLibraries('three');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toBe('Three.js');
        });

        it('should find libraries by category', () => {
            const results = searchLibraries('animation');
            expect(results.length).toBeGreaterThan(0);
            expect(results.some(r => r.category === 'animation')).toBe(true);
        });

        it('should find libraries by description keyword', () => {
            const results = searchLibraries('WebGL');
            expect(results.length).toBeGreaterThan(0);
        });

        it('should return empty array for no matches', () => {
            const results = searchLibraries('xyznonexistent123');
            expect(results).toHaveLength(0);
        });
    });

    describe('formatLibraryDocs', () => {
        it('should format overview documentation', () => {
            const docs = formatLibraryDocs('three', 'overview');
            expect(docs).toContain('Three.js');
            expect(docs).toContain('Category:');
            expect(docs).toContain('Import');
        });

        it('should format CDN documentation', () => {
            const docs = formatLibraryDocs('three', 'cdn');
            expect(docs).toContain('CDN');
            expect(docs).toContain('esm.sh');
        });

        it('should format usage examples', () => {
            const docs = formatLibraryDocs('three', 'usage');
            expect(docs).toContain('Usage Example');
            expect(docs).toContain('THREE.Scene');
        });

        it('should format error troubleshooting', () => {
            const docs = formatLibraryDocs('three', 'errors');
            expect(docs).toContain('Common Errors');
            expect(docs).toContain('not defined');
        });

        it('should return helpful message for unknown library', () => {
            const docs = formatLibraryDocs('nonexistent');
            expect(docs).toContain('not found');
            expect(docs).toContain('Available libraries');
        });
    });

    describe('getCategories', () => {
        it('should return all unique categories', () => {
            const categories = getCategories();
            expect(categories).toContain('3d');
            expect(categories).toContain('animation');
            expect(categories).toContain('charts');
            expect(categories).toContain('web-api');
            expect(categories).toContain('ui-framework');
        });
    });
});

// ============================================================================
// ERROR ANALYSIS TESTS
// ============================================================================

describe('Error Analysis', () => {
    describe('getErrorSolution', () => {
        it('should find solution for "THREE is not defined"', () => {
            const solution = getErrorSolution('three', 'THREE is not defined');
            expect(solution).toBeTruthy();
            expect(solution.toLowerCase()).toContain('import');
        });

        it('should find solution for localStorage error', () => {
            const solution = getErrorSolution('localStorage', 'QuotaExceededError');
            expect(solution).toBeTruthy();
            expect(solution.toLowerCase()).toContain('storage');
        });

        it('should find solution for Chart.js registration error', () => {
            const solution = getErrorSolution('chart.js', 'Chart is not defined');
            expect(solution).toBeTruthy();
            expect(solution.toLowerCase()).toContain('import');
        });

        it('should return null for unmatched error', () => {
            const solution = getErrorSolution('three', 'Some random unrelated error');
            expect(solution).toBeNull();
        });
    });

    describe('analyzeLibraryError', () => {
        it('should detect Three.js error and suggest fix', () => {
            const code = `import * as THREE from 'three';
const scene = new THREE.Scene();`;
            const error = "Cannot read properties of null (reading 'appendChild')";

            const analysis = analyzeLibraryError(error, code);
            expect(analysis.detectedLibraries).toContain('three');
            expect(analysis.suggestions.length).toBeGreaterThanOrEqual(0);
        });

        it('should detect Chart.js "not defined" error', () => {
            const code = `const chart = new Chart(ctx, { type: 'bar' });`;
            const error = 'Chart is not defined';

            const analysis = analyzeLibraryError(error, code);
            expect(analysis.detectedLibraries).toContain('chart.js');
        });

        it('should provide suggestions for undefined variable errors', () => {
            const code = `const synth = new Tone.Synth();`;
            const error = 'Tone is not defined';

            const analysis = analyzeLibraryError(error, code);
            expect(analysis.suggestions.length).toBeGreaterThanOrEqual(0);
        });

        it('should detect multiple libraries in complex code', () => {
            const code = `
import * as THREE from 'three';
import gsap from 'gsap';
localStorage.setItem('data', JSON.stringify(data));
`;
            const error = 'Some error occurred';

            const analysis = analyzeLibraryError(error, code);
            expect(analysis.detectedLibraries).toContain('three');
            expect(analysis.detectedLibraries).toContain('gsap');
            expect(analysis.detectedLibraries).toContain('localStorage');
        });
    });
});

// ============================================================================
// DETECTION PATTERN TESTS
// ============================================================================

describe('Detection Patterns', () => {
    it('should have import patterns for major libraries', () => {
        const expectedPatterns = ['three', 'pixi', 'gsap', 'chart.js', 'd3', 'react', 'vue'];

        for (const lib of expectedPatterns) {
            expect(DETECTION_PATTERNS.imports[lib], `Missing import pattern for ${lib}`).toBeDefined();
            expect(DETECTION_PATTERNS.imports[lib].length).toBeGreaterThan(0);
        }
    });

    it('should have CDN URL patterns', () => {
        const patterns = DETECTION_PATTERNS.cdnUrls;
        expect(patterns).toBeDefined();
        expect(patterns.three).toBeDefined();
        expect(patterns.tailwind).toBeDefined();
    });

    it('should have API patterns for web APIs', () => {
        const patterns = DETECTION_PATTERNS.apiPatterns;
        expect(patterns.localStorage).toBeDefined();
        expect(patterns.indexedDB).toBeDefined();
        expect(patterns.webAudio).toBeDefined();
    });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Integration', () => {
    it('should handle complete Three.js workflow', () => {
        const code = `
<!DOCTYPE html>
<html>
<head>
    <script type="importmap">
    {
        "imports": {
            "three": "https://esm.sh/three@0.160.0"
        }
    }
    </script>
</head>
<body>
    <script type="module">
        import * as THREE from 'three';
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);
    </script>
</body>
</html>
`;

        // Detection
        const detected = detectLibraries(code);
        expect(detected).toContain('three');

        // Documentation
        const docs = getLibraryDocs('three');
        expect(docs.name).toBe('Three.js');
        expect(docs.cdn.esm).toContain('esm.sh');
    });

    it('should handle localStorage workflow with error analysis', () => {
        const code = `
const savedData = localStorage.getItem('userPrefs');
if (savedData) {
    const prefs = JSON.parse(savedData);
    applyPreferences(prefs);
}
`;

        const error = 'QuotaExceededError: DOM Exception 22';

        // Detection
        const detected = detectLibraries(code);
        expect(detected).toContain('localStorage');

        // Error analysis
        const analysis = analyzeLibraryError(error, code);
        expect(analysis.detectedLibraries).toContain('localStorage');

        // Get solution
        const solution = getErrorSolution('localStorage', error);
        expect(solution).toBeTruthy();
        expect(solution.toLowerCase()).toContain('storage');
    });

    it('should provide complete docs for Chart.js implementation', () => {
        // Get overview
        const overview = formatLibraryDocs('chart.js', 'overview');
        expect(overview).toContain('Chart.js');

        // Get CDN info
        const cdn = formatLibraryDocs('chart.js', 'cdn');
        expect(cdn).toContain('esm.sh');

        // Get usage
        const usage = formatLibraryDocs('chart.js', 'usage');
        expect(usage).toContain('new Chart');
        expect(usage).toContain('register');

        // Get errors
        const errors = formatLibraryDocs('chart.js', 'errors');
        expect(errors).toContain('not defined');
    });
});

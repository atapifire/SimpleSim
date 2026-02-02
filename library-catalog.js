/**
 * Library Catalog - Comprehensive CDN/Library Tooling Support
 *
 * Provides autonomous documentation and tooling support for popular client-side libraries.
 * Models can query this catalog to:
 * - Get CDN links and import patterns
 * - Retrieve usage examples
 * - Access troubleshooting guides for common errors
 * - Discover compatible libraries
 */

// ============================================================================
// LIBRARY CATALOG
// ============================================================================

export const LIBRARY_CATALOG = {
    // -------------------------------------------------------------------------
    // 3D / Graphics / WebGPU
    // -------------------------------------------------------------------------
    'three': {
        name: 'Three.js',
        category: '3d',
        description: 'JavaScript 3D library for WebGL rendering',
        cdn: {
            esm: 'https://esm.sh/three@0.160.0',
            unpkg: 'https://unpkg.com/three@0.160.0/build/three.module.js',
            jsdelivr: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "three": "https://esm.sh/three@0.160.0",
        "three/addons/": "https://esm.sh/three@0.160.0/examples/jsm/"
    }
}
</script>`,
        usage: `import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Basic scene setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Add a cube
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// Add lighting
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(5, 5, 5);
scene.add(light);
scene.add(new THREE.AmbientLight(0x404040));

camera.position.z = 5;

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.01;
    renderer.render(scene, camera);
}
animate();

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});`,
        commonErrors: {
            'THREE is not defined': 'Add Three.js via import map before using. Make sure script has type="module".',
            'Cannot read properties of null': 'Ensure DOM element exists before appending renderer. Use DOMContentLoaded or place script at end of body.',
            'WebGL not supported': 'Add fallback check: if (!THREE.WebGLRenderer) { alert("WebGL not supported"); }',
            'Texture not loading': 'Use TextureLoader: new THREE.TextureLoader().load("path/to/image.png")'
        },
        tips: [
            'Always add lighting - MeshStandardMaterial needs light to be visible',
            'Clamp vertical rotation to prevent camera flipping: Math.max(-Math.PI/2, Math.min(Math.PI/2, rotation.x))',
            'Use OrbitControls for easy camera manipulation',
            'For mobile, use nipple.js for touch controls: https://esm.sh/nipplejs',
            'Dispose geometries and materials when removing objects to prevent memory leaks'
        ]
    },

    'pixi': {
        name: 'PixiJS',
        category: '2d',
        description: 'Fast 2D WebGL renderer',
        cdn: {
            esm: 'https://esm.sh/pixi.js@8',
            unpkg: 'https://unpkg.com/pixi.js@8/dist/pixi.min.js'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "pixi.js": "https://esm.sh/pixi.js@8"
    }
}
</script>`,
        usage: `import * as PIXI from 'pixi.js';

const app = new PIXI.Application();
await app.init({
    width: 800,
    height: 600,
    backgroundColor: 0x1099bb
});
document.body.appendChild(app.canvas);

// Create a sprite
const sprite = PIXI.Sprite.from('https://pixijs.com/assets/bunny.png');
sprite.anchor.set(0.5);
sprite.x = app.screen.width / 2;
sprite.y = app.screen.height / 2;
app.stage.addChild(sprite);

// Animation
app.ticker.add(() => {
    sprite.rotation += 0.01;
});`,
        commonErrors: {
            'PIXI is not defined': 'Import PIXI before using. Ensure script has type="module".',
            'Cannot read property canvas': 'PixiJS v8 requires await app.init() before accessing app.canvas'
        },
        tips: [
            'PixiJS v8 uses async initialization',
            'Use sprite sheets for better performance',
            'Enable WebGL2 for better effects'
        ]
    },

    // -------------------------------------------------------------------------
    // Animation
    // -------------------------------------------------------------------------
    'gsap': {
        name: 'GSAP',
        category: 'animation',
        description: 'Professional-grade animation library',
        cdn: {
            esm: 'https://esm.sh/gsap@3.12.0',
            cdn: 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.0/gsap.min.js'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "gsap": "https://esm.sh/gsap@3.12.0"
    }
}
</script>`,
        usage: `import gsap from 'gsap';

// Simple tween
gsap.to('.box', {
    x: 200,
    rotation: 360,
    duration: 2,
    ease: 'power2.out'
});

// Timeline for sequenced animations
const tl = gsap.timeline();
tl.to('.box', { x: 100, duration: 1 })
  .to('.box', { y: 100, duration: 1 })
  .to('.box', { rotation: 360, duration: 1 });

// Stagger multiple elements
gsap.to('.item', {
    y: 50,
    opacity: 1,
    stagger: 0.1,
    duration: 0.5
});`,
        commonErrors: {
            'gsap is not defined': 'Import GSAP before using. Check import map syntax.',
            'Target not found': 'Ensure element exists in DOM before animating. Use DOMContentLoaded.'
        },
        tips: [
            'Use gsap.timeline() for complex sequences',
            'ScrollTrigger plugin available at https://esm.sh/gsap@3.12.0/ScrollTrigger',
            'Use ease strings like "power2.out", "elastic.out(1, 0.3)"'
        ]
    },

    'animejs': {
        name: 'Anime.js',
        category: 'animation',
        description: 'Lightweight JavaScript animation library',
        cdn: {
            esm: 'https://esm.sh/animejs@3.2.2'
        },
        importPattern: `<script type="module">
import anime from 'https://esm.sh/animejs@3.2.2';
</script>`,
        usage: `import anime from 'https://esm.sh/animejs@3.2.2';

anime({
    targets: '.box',
    translateX: 250,
    rotate: '1turn',
    duration: 2000,
    easing: 'easeInOutQuad',
    loop: true
});`,
        commonErrors: {
            'anime is not defined': 'Import anime.js before using.'
        },
        tips: [
            'Use anime.stagger() for sequential delays',
            'SVG morphing supported with anime.js'
        ]
    },

    // -------------------------------------------------------------------------
    // Charts / Data Visualization
    // -------------------------------------------------------------------------
    'chart.js': {
        name: 'Chart.js',
        category: 'charts',
        description: 'Simple yet flexible JavaScript charting',
        cdn: {
            esm: 'https://esm.sh/chart.js@4',
            cdn: 'https://cdn.jsdelivr.net/npm/chart.js@4'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "chart.js": "https://esm.sh/chart.js@4"
    }
}
</script>`,
        usage: `import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

const ctx = document.getElementById('myChart').getContext('2d');
const chart = new Chart(ctx, {
    type: 'bar',
    data: {
        labels: ['Red', 'Blue', 'Yellow', 'Green', 'Purple'],
        datasets: [{
            label: 'Votes',
            data: [12, 19, 3, 5, 2],
            backgroundColor: [
                'rgba(255, 99, 132, 0.5)',
                'rgba(54, 162, 235, 0.5)',
                'rgba(255, 206, 86, 0.5)',
                'rgba(75, 192, 192, 0.5)',
                'rgba(153, 102, 255, 0.5)'
            ],
            borderColor: [
                'rgb(255, 99, 132)',
                'rgb(54, 162, 235)',
                'rgb(255, 206, 86)',
                'rgb(75, 192, 192)',
                'rgb(153, 102, 255)'
            ],
            borderWidth: 1
        }]
    },
    options: {
        responsive: true,
        scales: {
            y: { beginAtZero: true }
        }
    }
});`,
        commonErrors: {
            'Chart is not defined': 'Import Chart from chart.js. Remember to register components with Chart.register(...registerables).',
            'Canvas is already in use': 'Destroy existing chart before creating new one: chart.destroy()'
        },
        tips: [
            'Always register components: Chart.register(...registerables)',
            'Make charts responsive with options.responsive: true',
            'Use chart.update() to update data dynamically'
        ]
    },

    'd3': {
        name: 'D3.js',
        category: 'charts',
        description: 'Data-Driven Documents - powerful data visualization',
        cdn: {
            esm: 'https://esm.sh/d3@7',
            cdn: 'https://cdn.jsdelivr.net/npm/d3@7'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "d3": "https://esm.sh/d3@7"
    }
}
</script>`,
        usage: `import * as d3 from 'd3';

const data = [30, 86, 168, 281, 303, 365];

const svg = d3.select('#chart')
    .append('svg')
    .attr('width', 500)
    .attr('height', 300);

svg.selectAll('rect')
    .data(data)
    .enter()
    .append('rect')
    .attr('x', (d, i) => i * 70)
    .attr('y', d => 300 - d)
    .attr('width', 60)
    .attr('height', d => d)
    .attr('fill', 'steelblue');`,
        commonErrors: {
            'd3 is not defined': 'Import D3 before using.',
            'Cannot read property select': 'Ensure D3 is loaded and element exists in DOM.'
        },
        tips: [
            'Use d3.select() for single elements, d3.selectAll() for multiple',
            'Chain methods for declarative data binding',
            'Use enter/update/exit pattern for dynamic data'
        ]
    },

    // -------------------------------------------------------------------------
    // Audio
    // -------------------------------------------------------------------------
    'tone': {
        name: 'Tone.js',
        category: 'audio',
        description: 'Web Audio framework for music and sound',
        cdn: {
            esm: 'https://esm.sh/tone@14'
        },
        importPattern: `<script type="module">
import * as Tone from 'https://esm.sh/tone@14';
</script>`,
        usage: `import * as Tone from 'https://esm.sh/tone@14';

// Start audio context (must be triggered by user action)
document.getElementById('playButton').addEventListener('click', async () => {
    await Tone.start();

    // Create a synth
    const synth = new Tone.Synth().toDestination();
    synth.triggerAttackRelease('C4', '8n');

    // Play a sequence
    const seq = new Tone.Sequence((time, note) => {
        synth.triggerAttackRelease(note, 0.1, time);
    }, ['C4', 'E4', 'G4', 'B4'], '8n').start(0);

    Tone.Transport.start();
});`,
        commonErrors: {
            'Audio context not started': 'Call Tone.start() on user interaction (click/tap).',
            'Tone is not defined': 'Import Tone.js before using.'
        },
        tips: [
            'Always start audio context with user gesture',
            'Use Tone.Transport for timing and scheduling',
            'Tone.js handles browser audio quirks automatically'
        ]
    },

    // -------------------------------------------------------------------------
    // Maps / Geolocation
    // -------------------------------------------------------------------------
    'leaflet': {
        name: 'Leaflet',
        category: 'maps',
        description: 'Mobile-friendly interactive maps',
        cdn: {
            js: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
            css: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
            esm: 'https://esm.sh/leaflet@1.9.4'
        },
        importPattern: `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>`,
        usage: `// In HTML: <div id="map" style="height: 400px;"></div>

const map = L.map('map').setView([51.505, -0.09], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Add a marker
L.marker([51.5, -0.09]).addTo(map)
    .bindPopup('Hello World!')
    .openPopup();`,
        commonErrors: {
            'L is not defined': 'Include Leaflet JS before your script.',
            'Map container not found': 'Ensure #map element exists and has a height set.'
        },
        tips: [
            'Map container MUST have explicit height',
            'Use OpenStreetMap tiles (free, no API key)',
            'call map.invalidateSize() if map is in a hidden container'
        ]
    },

    // -------------------------------------------------------------------------
    // UI Frameworks
    // -------------------------------------------------------------------------
    'react': {
        name: 'React',
        category: 'ui-framework',
        description: 'JavaScript library for building user interfaces',
        cdn: {
            esm: 'https://esm.sh/react@18',
            reactDom: 'https://esm.sh/react-dom@18'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "react": "https://esm.sh/react@18",
        "react-dom": "https://esm.sh/react-dom@18",
        "react-dom/client": "https://esm.sh/react-dom@18/client"
    }
}
</script>`,
        usage: `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

function Counter() {
    const [count, setCount] = useState(0);
    return (
        React.createElement('div', null,
            React.createElement('p', null, 'Count: ', count),
            React.createElement('button', { onClick: () => setCount(c => c + 1) }, 'Increment')
        )
    );
}

// Note: Without JSX transformation, use React.createElement
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(Counter));`,
        commonErrors: {
            'React is not defined': 'Import React before using JSX or React.createElement.',
            'createRoot is not a function': 'Import from react-dom/client for React 18.'
        },
        tips: [
            'Without a bundler, use React.createElement instead of JSX',
            'For JSX, consider htm library: https://esm.sh/htm',
            'Use hooks for state management: useState, useEffect, etc.'
        ]
    },

    'vue': {
        name: 'Vue',
        category: 'ui-framework',
        description: 'Progressive JavaScript framework',
        cdn: {
            esm: 'https://esm.sh/vue@3',
            cdn: 'https://unpkg.com/vue@3/dist/vue.global.js'
        },
        importPattern: `<script type="importmap">
{
    "imports": {
        "vue": "https://esm.sh/vue@3"
    }
}
</script>`,
        usage: `import { createApp, ref } from 'vue';

const app = createApp({
    setup() {
        const count = ref(0);
        const increment = () => count.value++;
        return { count, increment };
    },
    template: \`
        <div>
            <p>Count: {{ count }}</p>
            <button @click="increment">Increment</button>
        </div>
    \`
});

app.mount('#app');`,
        commonErrors: {
            'Vue is not defined': 'Import Vue before using.',
            'Failed to mount': 'Ensure #app element exists in DOM.'
        },
        tips: [
            'Use Composition API (setup) for better TypeScript support',
            'Templates can be inline strings or in <template> tags',
            'ref() for primitives, reactive() for objects'
        ]
    },

    // -------------------------------------------------------------------------
    // Styling
    // -------------------------------------------------------------------------
    'tailwind': {
        name: 'Tailwind CSS (via Twind)',
        category: 'styling',
        description: 'Utility-first CSS framework',
        cdn: {
            twind: 'https://cdn.twind.style',
            play: 'https://cdn.tailwindcss.com'
        },
        importPattern: `<!-- Option 1: Twind (recommended for production) -->
<script src="https://cdn.twind.style" crossorigin></script>

<!-- Option 2: Tailwind Play CDN (development only) -->
<script src="https://cdn.tailwindcss.com"></script>`,
        usage: `<!-- With Twind or Tailwind CDN, just use classes directly -->
<div class="min-h-screen bg-gray-100 flex items-center justify-center">
    <div class="bg-white p-8 rounded-lg shadow-lg">
        <h1 class="text-2xl font-bold text-gray-800 mb-4">Hello World</h1>
        <button class="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition">
            Click Me
        </button>
    </div>
</div>`,
        commonErrors: {
            'Classes not working': 'Ensure Twind or Tailwind CDN is loaded in <head>.',
            'Styles not applying': 'Check for typos in class names. Use Tailwind docs for reference.'
        },
        tips: [
            'Twind is lighter and faster than Tailwind CDN',
            'Use responsive prefixes: sm:, md:, lg:, xl:',
            'Hover/focus states: hover:bg-blue-600, focus:ring-2'
        ]
    },

    // -------------------------------------------------------------------------
    // Web APIs (built-in, no CDN needed)
    // -------------------------------------------------------------------------
    'localStorage': {
        name: 'Web Storage (localStorage)',
        category: 'web-api',
        description: 'Browser storage API for persistent data',
        cdn: null,
        importPattern: '<!-- No import needed - built-in browser API -->',
        usage: `// Store data
localStorage.setItem('username', 'john');
localStorage.setItem('settings', JSON.stringify({ theme: 'dark', lang: 'en' }));

// Retrieve data
const username = localStorage.getItem('username');
const settings = JSON.parse(localStorage.getItem('settings') || '{}');

// Remove data
localStorage.removeItem('username');

// Clear all
localStorage.clear();

// Check storage availability
function storageAvailable() {
    try {
        const test = '__storage_test__';
        localStorage.setItem(test, test);
        localStorage.removeItem(test);
        return true;
    } catch (e) {
        return false;
    }
}`,
        commonErrors: {
            'localStorage is not defined': 'localStorage is not available in private/incognito mode in some browsers.',
            'QuotaExceededError': 'Storage limit reached (~5MB). Clear old data or use IndexedDB for larger storage.'
        },
        tips: [
            'Always JSON.stringify() objects before storing',
            'localStorage persists across sessions, sessionStorage clears on tab close',
            'Wrap in try/catch for private browsing mode support'
        ]
    },

    'indexedDB': {
        name: 'IndexedDB',
        category: 'web-api',
        description: 'Low-level browser database for large structured data',
        cdn: {
            idb: 'https://esm.sh/idb@7' // Wrapper library for easier API
        },
        importPattern: `<!-- For easier API, use idb wrapper -->
<script type="module">
import { openDB } from 'https://esm.sh/idb@7';
</script>`,
        usage: `// Using idb wrapper (recommended)
import { openDB } from 'https://esm.sh/idb@7';

const db = await openDB('my-database', 1, {
    upgrade(db) {
        db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    }
});

// Add item
await db.add('items', { name: 'Item 1', value: 42 });

// Get item
const item = await db.get('items', 1);

// Get all items
const allItems = await db.getAll('items');

// Update item
await db.put('items', { id: 1, name: 'Updated Item', value: 100 });

// Delete item
await db.delete('items', 1);`,
        commonErrors: {
            'Database blocked': 'Close other tabs using the same database.',
            'Version error': 'Increment version number when changing schema.'
        },
        tips: [
            'Use idb wrapper library for promise-based API',
            'IndexedDB supports transactions for data integrity',
            'Good for offline apps and large datasets'
        ]
    },

    'webAudio': {
        name: 'Web Audio API',
        category: 'web-api',
        description: 'High-level audio processing and synthesis',
        cdn: null,
        importPattern: '<!-- No import needed - built-in browser API -->',
        usage: `// Create audio context (must be triggered by user action)
let audioContext;

document.getElementById('playBtn').addEventListener('click', () => {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Create oscillator (tone generator)
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.type = 'sine'; // sine, square, sawtooth, triangle
    oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note

    gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 1);

    oscillator.start();
    oscillator.stop(audioContext.currentTime + 1);
});

// Load and play audio file
async function playAudioFile(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start();
}`,
        commonErrors: {
            'AudioContext was not allowed': 'Must be created/resumed from user gesture (click/tap).',
            'decodeAudioData failed': 'Audio file format not supported or corrupted.'
        },
        tips: [
            'Always create/resume AudioContext on user interaction',
            'Use GainNode for volume control',
            'Prefer Web Audio API over howler.js for better control'
        ]
    },

    // -------------------------------------------------------------------------
    // Forms / Validation
    // -------------------------------------------------------------------------
    'zod': {
        name: 'Zod',
        category: 'validation',
        description: 'TypeScript-first schema validation',
        cdn: {
            esm: 'https://esm.sh/zod@3'
        },
        importPattern: `<script type="module">
import { z } from 'https://esm.sh/zod@3';
</script>`,
        usage: `import { z } from 'https://esm.sh/zod@3';

// Define a schema
const UserSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    age: z.number().min(18, 'Must be 18 or older').optional()
});

// Validate data
function validateForm(data) {
    const result = UserSchema.safeParse(data);

    if (!result.success) {
        // Get formatted errors
        const errors = result.error.flatten().fieldErrors;
        console.log(errors);
        // { name: ['Name must be at least 2 characters'], email: ['Invalid email address'] }
        return { valid: false, errors };
    }

    return { valid: true, data: result.data };
}

// Example usage
const formData = { name: 'J', email: 'invalid', age: 15 };
const validation = validateForm(formData);`,
        commonErrors: {
            'z is not defined': 'Import Zod before using.',
            'Cannot call parse on undefined': 'Ensure schema is defined before parsing.'
        },
        tips: [
            'Use safeParse() for validation without throwing',
            'Chain validators: z.string().email().min(5)',
            'Use .flatten() for user-friendly error messages'
        ]
    },

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------
    'dayjs': {
        name: 'Day.js',
        category: 'utility',
        description: 'Lightweight date library (Moment.js alternative)',
        cdn: {
            esm: 'https://esm.sh/dayjs@1'
        },
        importPattern: `<script type="module">
import dayjs from 'https://esm.sh/dayjs@1';
</script>`,
        usage: `import dayjs from 'https://esm.sh/dayjs@1';

// Current date/time
const now = dayjs();

// Format dates
console.log(now.format('YYYY-MM-DD'));        // 2024-01-15
console.log(now.format('MMM D, YYYY'));       // Jan 15, 2024
console.log(now.format('h:mm A'));            // 2:30 PM

// Parse dates
const date = dayjs('2024-06-15');

// Manipulate
const nextWeek = now.add(7, 'day');
const lastMonth = now.subtract(1, 'month');

// Compare
const isBefore = date.isBefore(now);
const diff = date.diff(now, 'day');`,
        commonErrors: {
            'dayjs is not a function': 'Import dayjs default export.',
            'Invalid date': 'Check date string format matches expected pattern.'
        },
        tips: [
            'Day.js is 2KB vs Moment.js at 70KB',
            'Plugins available for advanced features',
            'API is mostly compatible with Moment.js'
        ]
    },

    'confetti': {
        name: 'Canvas Confetti',
        category: 'utility',
        description: 'Confetti animation library',
        cdn: {
            esm: 'https://esm.sh/canvas-confetti@1'
        },
        importPattern: `<script type="module">
import confetti from 'https://esm.sh/canvas-confetti@1';
</script>`,
        usage: `import confetti from 'https://esm.sh/canvas-confetti@1';

// Basic confetti burst
confetti();

// Customized confetti
confetti({
    particleCount: 100,
    spread: 70,
    origin: { x: 0.5, y: 0.6 },
    colors: ['#ff0000', '#00ff00', '#0000ff']
});

// Confetti from both sides
function celebate() {
    confetti({ angle: 60, spread: 55, origin: { x: 0 } });
    confetti({ angle: 120, spread: 55, origin: { x: 1 } });
}`,
        commonErrors: {
            'confetti is not a function': 'Import confetti default export.'
        },
        tips: [
            'origin.y: 0 = top, 1 = bottom',
            'Use setTimeout for sequenced bursts',
            'Great for celebrating user achievements'
        ]
    }
};

// ============================================================================
// DETECTION PATTERNS
// ============================================================================

/**
 * Patterns to detect library usage in code
 */
export const DETECTION_PATTERNS = {
    // Import statement patterns
    imports: {
        'three': [/from\s+['"]three['"]/i, /import\s+\*\s+as\s+THREE/i, /THREE\./],
        'pixi': [/from\s+['"]pixi\.js['"]/i, /PIXI\./],
        'gsap': [/from\s+['"]gsap['"]/i, /gsap\./i],
        'animejs': [/from\s+['"]animejs['"]/i, /anime\(/],
        'chart.js': [/from\s+['"]chart\.js['"]/i, /new\s+Chart\(/],
        'd3': [/from\s+['"]d3['"]/i, /d3\./],
        'tone': [/from\s+['"]tone['"]/i, /Tone\./],
        'leaflet': [/L\.map\(/, /L\.tileLayer\(/, /L\.marker\(/],
        'react': [/from\s+['"]react['"]/i, /React\./, /useState\(/, /useEffect\(/],
        'vue': [/from\s+['"]vue['"]/i, /createApp\(/, /\.mount\(/],
        'zod': [/from\s+['"]zod['"]/i, /z\.object\(/, /z\.string\(/],
        'dayjs': [/from\s+['"]dayjs['"]/i, /dayjs\(/]
    },
    // CDN URL patterns
    cdnUrls: {
        'three': [/esm\.sh\/three/, /unpkg\.com\/three/, /jsdelivr.*three/],
        'chart.js': [/esm\.sh\/chart\.js/, /chart\.js/],
        'gsap': [/esm\.sh\/gsap/, /cdnjs.*gsap/],
        'tailwind': [/cdn\.twind\.style/, /cdn\.tailwindcss\.com/],
        'leaflet': [/unpkg\.com\/leaflet/, /leaflet\.css/, /leaflet\.js/],
        'react': [/esm\.sh\/react/],
        'vue': [/esm\.sh\/vue/, /unpkg\.com\/vue/]
    },
    // API pattern detection
    apiPatterns: {
        'localStorage': [/localStorage\.(get|set|remove)Item/, /localStorage\.clear/],
        'indexedDB': [/indexedDB\.open/, /openDB\(/, /\.createObjectStore/],
        'webAudio': [/AudioContext/, /createOscillator/, /createGain/],
        'fetch': [/fetch\(/, /\.json\(\)/],
        'canvas': [/getContext\(['"]2d['"]\)/, /\.fillRect\(/, /\.drawImage\(/]
    }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Detect which libraries are being used in code
 * @param {string} code - Code content to analyze
 * @returns {string[]} Array of detected library names
 */
export function detectLibraries(code) {
    const detected = new Set();

    // Check import patterns
    for (const [lib, patterns] of Object.entries(DETECTION_PATTERNS.imports)) {
        for (const pattern of patterns) {
            if (pattern.test(code)) {
                detected.add(lib);
                break;
            }
        }
    }

    // Check CDN URLs
    for (const [lib, patterns] of Object.entries(DETECTION_PATTERNS.cdnUrls)) {
        for (const pattern of patterns) {
            if (pattern.test(code)) {
                detected.add(lib);
                break;
            }
        }
    }

    // Check API patterns
    for (const [lib, patterns] of Object.entries(DETECTION_PATTERNS.apiPatterns)) {
        for (const pattern of patterns) {
            if (pattern.test(code)) {
                detected.add(lib);
                break;
            }
        }
    }

    return [...detected];
}

/**
 * Get documentation for a specific library
 * @param {string} libraryName - Library name (e.g., 'three', 'chart.js')
 * @returns {object|null} Library documentation or null if not found
 */
export function getLibraryDocs(libraryName) {
    const normalizedName = libraryName.toLowerCase().replace(/\.js$/, '').replace(/-/g, '');

    // Direct match
    if (LIBRARY_CATALOG[libraryName]) {
        return LIBRARY_CATALOG[libraryName];
    }

    // Normalized match
    for (const [key, value] of Object.entries(LIBRARY_CATALOG)) {
        const normalizedKey = key.toLowerCase().replace(/\.js$/, '').replace(/-/g, '');
        if (normalizedKey === normalizedName) {
            return value;
        }
    }

    // Partial match (name contains search term)
    for (const [key, value] of Object.entries(LIBRARY_CATALOG)) {
        const normalizedKey = key.toLowerCase().replace(/\.js$/, '').replace(/-/g, '');
        const normalizedLibName = value.name.toLowerCase().replace(/\.js$/, '').replace(/-/g, '').replace(/\s/g, '');
        if (normalizedKey.includes(normalizedName) || normalizedName.includes(normalizedKey) ||
            normalizedLibName.includes(normalizedName) || normalizedName.includes(normalizedLibName)) {
            return value;
        }
    }

    return null;
}

/**
 * Get libraries by category
 * @param {string} category - Category name (e.g., '3d', 'animation', 'charts')
 * @returns {object[]} Array of libraries in that category
 */
export function getLibrariesByCategory(category) {
    return Object.entries(LIBRARY_CATALOG)
        .filter(([_, lib]) => lib.category === category)
        .map(([key, lib]) => ({ id: key, ...lib }));
}

/**
 * Get error solution for a specific library and error message
 * @param {string} libraryName - Library name
 * @param {string} errorMessage - Error message to match
 * @returns {string|null} Solution or null if not found
 */
export function getErrorSolution(libraryName, errorMessage) {
    const lib = getLibraryDocs(libraryName);
    if (!lib || !lib.commonErrors) return null;

    const lowerError = errorMessage.toLowerCase();

    for (const [errorPattern, solution] of Object.entries(lib.commonErrors)) {
        if (lowerError.includes(errorPattern.toLowerCase())) {
            return solution;
        }
    }

    return null;
}

/**
 * Analyze error message and suggest library-specific fixes
 * @param {string} errorMessage - Error message from runtime
 * @param {string} code - Code content for context
 * @returns {object} Analysis result with library, error type, and suggestions
 */
export function analyzeLibraryError(errorMessage, code) {
    const detectedLibs = detectLibraries(code);
    const suggestions = [];

    for (const lib of detectedLibs) {
        const solution = getErrorSolution(lib, errorMessage);
        if (solution) {
            suggestions.push({
                library: lib,
                solution,
                docs: getLibraryDocs(lib)
            });
        }
    }

    // Check for common patterns
    if (errorMessage.includes('is not defined')) {
        const match = errorMessage.match(/(\w+) is not defined/);
        if (match) {
            const undefinedVar = match[1];
            // Check if it's a known library global
            const possibleLib = Object.entries(LIBRARY_CATALOG).find(([key, lib]) => {
                return lib.usage && lib.usage.includes(undefinedVar);
            });
            if (possibleLib) {
                suggestions.push({
                    library: possibleLib[0],
                    solution: `Import ${possibleLib[1].name} before using ${undefinedVar}`,
                    docs: possibleLib[1]
                });
            }
        }
    }

    return {
        detectedLibraries: detectedLibs,
        suggestions,
        hasLibraryRelatedError: suggestions.length > 0
    };
}

/**
 * Get all available library categories
 * @returns {string[]} Array of unique categories
 */
export function getCategories() {
    const categories = new Set();
    for (const lib of Object.values(LIBRARY_CATALOG)) {
        categories.add(lib.category);
    }
    return [...categories].sort();
}

/**
 * Search libraries by query
 * @param {string} query - Search query
 * @returns {object[]} Matching libraries
 */
export function searchLibraries(query) {
    const lowerQuery = query.toLowerCase();
    return Object.entries(LIBRARY_CATALOG)
        .filter(([key, lib]) => {
            return key.includes(lowerQuery) ||
                   lib.name.toLowerCase().includes(lowerQuery) ||
                   lib.description.toLowerCase().includes(lowerQuery) ||
                   lib.category.includes(lowerQuery);
        })
        .map(([key, lib]) => ({ id: key, ...lib }));
}

/**
 * Format library documentation for model consumption
 * @param {string} libraryName - Library name
 * @param {string} queryType - Type of info needed: 'overview', 'usage', 'errors', 'cdn'
 * @returns {string} Formatted documentation string
 */
export function formatLibraryDocs(libraryName, queryType = 'overview') {
    const lib = getLibraryDocs(libraryName);
    if (!lib) {
        return `Library "${libraryName}" not found in catalog. Available libraries: ${Object.keys(LIBRARY_CATALOG).join(', ')}`;
    }

    switch (queryType) {
        case 'cdn':
            return `# ${lib.name} - CDN Links

${lib.importPattern}

CDN URLs:
${lib.cdn ? Object.entries(lib.cdn).map(([key, url]) => `- ${key}: ${url}`).join('\n') : 'Built-in browser API, no CDN needed'}`;

        case 'usage':
            return `# ${lib.name} - Usage Example

${lib.importPattern}

\`\`\`javascript
${lib.usage}
\`\`\`

Tips:
${lib.tips?.map(t => `- ${t}`).join('\n') || 'No specific tips'}`;

        case 'errors':
            return `# ${lib.name} - Common Errors & Solutions

${Object.entries(lib.commonErrors || {}).map(([err, sol]) => `## ${err}
${sol}`).join('\n\n')}`;

        case 'overview':
        default:
            return `# ${lib.name}
Category: ${lib.category}
${lib.description}

## Import
${lib.importPattern}

## Quick Example
\`\`\`javascript
${lib.usage?.split('\n').slice(0, 15).join('\n')}...
\`\`\`

## Tips
${lib.tips?.slice(0, 3).map(t => `- ${t}`).join('\n') || 'No specific tips'}`;
    }
}

# Comprehensive Plan: Agent Error Handling & Code Quality Enforcement

## Executive Summary

The SimpleSim agent currently completes projects with runtime errors because:
1. **No enforcement** - Agent is told to check errors but can ignore instructions
2. **Module handling broken** - ES module scripts are inlined without `type="module"`
3. **finish() doesn't validate** - Agent can complete without any error checking
4. **Server accepts blindly** - No server-side validation of generated code

This plan addresses all issues with production-ready solutions following 2026 best practices for agentic AI code generation.

---

## Root Cause Analysis

### Issue 1: "Cannot use import statement outside a module"
**Location:** `renderer.js:172-184`

The renderer inlines JavaScript files but strips `type="module"`:
```javascript
// CURRENT (BROKEN):
return `<script>/* Inlined: ${src} */\n${content}\n</script>`;

// Should detect module syntax and preserve type="module"
```

### Issue 2: "THREE is not defined"
**Cause:** Agent creates code using THREE but:
- Doesn't properly import it
- OR uses import without `type="module"` on script tag
- Agent calls `finish()` without checking `get_preview_errors()`

### Issue 3: No Enforcement of Error Checking
**Location:** `agent.js:748-763`

The `finish()` tool only validates static file structure, not runtime errors:
```javascript
case 'finish': {
    const validation = validateProjectBeforeFinish();
    // ^ Only checks file structure, not preview errors!
    if (!validation.valid) {
        return { success: false, ... };
    }
    return { success: true, finished: true };  // Accepts without error check
}
```

### Issue 4: DOM Mismatches Treated as Warnings
**Location:** `agent.js:405-409`

DOM element mismatches don't block finish:
```javascript
const criticalIssues = issues.filter(i =>
    i.includes('missing') ||
    i.includes('syntax errors') ||
    i.includes('not found')
    // DOM mismatches NOT included - allowed to pass!
);
```

---

## Implementation Plan

### Phase 1: Fix Module Script Handling (CRITICAL)

**File:** `renderer.js`

#### 1.1 Detect ES Module Syntax
```javascript
/**
 * Check if JavaScript content uses ES module syntax
 */
function isESModule(jsContent) {
    // Check for import/export statements
    const modulePatterns = [
        /^\s*import\s+/m,           // import statements
        /^\s*import\s*\(/m,         // dynamic import()
        /^\s*export\s+/m,           // export statements
        /from\s+['"][^'"]+['"]/,    // from 'module'
    ];
    return modulePatterns.some(p => p.test(jsContent));
}
```

#### 1.2 Update Script Inlining to Preserve Module Type
```javascript
// In the script replacement regex handler (lines 172-184):
combinedHTML = combinedHTML.replace(
    /<script\s+([^>]*)src\s*=\s*["'](?!https?:\/\/|\/\/)([^"']+\.js)["']([^>]*)>\s*<\/script>/gi,
    (match, beforeSrc, src, afterSrc) => {
        const content = jsFiles.get(src) || jsFiles.get(src.replace(/^\.\//, ''));
        if (content) {
            devLog(`Inlining script: ${src}`);

            // Preserve type="module" if present in original OR if content uses ES modules
            const hasModuleType = /type\s*=\s*["']module["']/i.test(beforeSrc + afterSrc);
            const needsModule = hasModuleType || isESModule(content);
            const moduleAttr = needsModule ? ' type="module"' : '';

            return `<script${moduleAttr}>/* Inlined: ${src} */\n${content}\n</script>`;
        }
        devLog(`Removing missing script reference: ${src}`);
        return `<!-- Script not found: ${src} -->`;
    }
);
```

#### 1.3 Update JS Injection to Handle Modules
```javascript
// Lines 240-250: When injecting additional JS
if (allJs) {
    const needsModule = isESModule(allJs);
    const moduleAttr = needsModule ? ' type="module"' : '';
    const jsTag = `<script${moduleAttr}>\n${allJs}\n</script>`;
    // ... rest of injection logic
}
```

---

### Phase 2: Enforce Error Checking Before Finish (CRITICAL)

**File:** `agent.js`

#### 2.1 Track Whether Error Check Was Performed
```javascript
// Add at top of agent.js (near line 50)
let errorCheckPerformed = false;
let lastPreviewErrors = null;

// Reset in runAgent (near line 824)
errorCheckPerformed = false;
lastPreviewErrors = null;
```

#### 2.2 Update get_preview_errors to Track Usage
```javascript
case 'get_preview_errors': {
    const errors = getPreviewErrors();

    // Track that error check was performed
    errorCheckPerformed = true;
    lastPreviewErrors = errors;

    // ... rest of existing logic
}
```

#### 2.3 Update finish() to REQUIRE Error Check
```javascript
case 'finish': {
    // ENFORCEMENT: Must have checked for errors
    if (!errorCheckPerformed) {
        return {
            success: false,
            error: 'Cannot finish without checking for errors',
            hint: 'Call preview_site() then get_preview_errors() before finish(). This ensures the generated code actually works.',
            required_action: 'preview_errors_check'
        };
    }

    // ENFORCEMENT: Must have no runtime errors
    if (lastPreviewErrors && lastPreviewErrors.hasErrors) {
        const errorSummary = lastPreviewErrors.errors
            .slice(0, 3)
            .map(e => e.message)
            .join('; ');
        return {
            success: false,
            error: 'Cannot finish - runtime errors detected',
            issues: lastPreviewErrors.errors.map(e => e.message),
            hint: `Fix these errors before calling finish(): ${errorSummary}`,
            required_action: 'fix_runtime_errors'
        };
    }

    // Existing validation
    const validation = validateProjectBeforeFinish();
    if (!validation.valid) {
        return {
            success: false,
            error: 'Cannot finish yet - project incomplete',
            issues: validation.issues,
            hint: validation.hint
        };
    }

    return { success: true, finished: true, summary: args.summary };
}
```

#### 2.4 Make DOM Mismatches Critical
```javascript
// Update validateProjectBeforeFinish (around line 405)
const criticalIssues = issues.filter(i =>
    i.includes('missing') ||
    i.includes('syntax errors') ||
    i.includes('not found') ||
    i.includes('DOM element mismatch') ||  // ADD THIS
    i.includes('not exist in HTML')         // ADD THIS
);
```

---

### Phase 3: Add Automatic Error Recovery Loop

**File:** `agent.js`

#### 3.1 Auto-Render and Check After Each Write
When the agent writes or edits files, automatically trigger a preview check:

```javascript
case 'write_file': {
    // ... existing write logic ...

    // Auto-preview after writing HTML or JS files
    if (args.path.endsWith('.html') || args.path.endsWith('.js')) {
        // Reset error check flag - new code needs validation
        errorCheckPerformed = false;
    }

    return {
        success: true,
        message: `File written: ${args.path}`,
        hint: args.path.endsWith('.js') || args.path.endsWith('.html')
            ? 'Code changed. Call preview_site() and get_preview_errors() to verify it works.'
            : undefined
    };
}
```

#### 3.2 Add force_error_check Tool
```javascript
{
    type: "function",
    function: {
        name: "validate_and_preview",
        description: "Render the site, wait for JavaScript execution, and return any errors. This is a convenience tool that combines preview_site + get_preview_errors. MUST be called before finish().",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    }
}
```

Implementation:
```javascript
case 'validate_and_preview': {
    try {
        // Clear and render
        clearPreviewErrors();
        renderProject(workingFiles);

        // Wait for JS execution
        await new Promise(resolve => setTimeout(resolve, 500));

        // Get errors
        const errors = getPreviewErrors();
        errorCheckPerformed = true;
        lastPreviewErrors = errors;

        // Also do DOM analysis
        const domAnalysis = analyzeDomReferences(workingFiles);

        if (!errors.hasErrors && domAnalysis.valid) {
            return {
                success: true,
                valid: true,
                message: 'Project validated successfully. No errors detected.',
                hint: 'You can now call finish() to complete.'
            };
        }

        // Compile all issues
        const allIssues = [];
        if (errors.hasErrors) {
            allIssues.push(...errors.errors.map(e => `Runtime: ${e.message}`));
        }
        if (!domAnalysis.valid) {
            allIssues.push(...domAnalysis.issues.map(i => `DOM: ${i.message}`));
        }

        return {
            success: true,
            valid: false,
            issues: allIssues,
            runtimeErrors: errors.errors,
            domIssues: domAnalysis.issues,
            hint: 'Fix these issues before calling finish().'
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
```

---

### Phase 4: Update System Prompts for Clarity

**File:** `agent.js`

#### 4.1 Update Workflow Instructions
```javascript
const workflowInstructions = isNewProject
    ? `
WORKFLOW FOR NEW PROJECT:
1. Read the starter files first (list_files, read_file)
2. Plan what files you need: index.html (required), style.css, script.js
3. Build the complete site - create all necessary files
4. For ES modules (import/export), ensure <script type="module">
5. After creating files, call validate_and_preview()
6. If errors found, FIX THEM and validate again
7. ONLY call finish() when validate_and_preview() returns valid: true

CRITICAL RULES:
- finish() will REJECT if you haven't called validate_and_preview()
- finish() will REJECT if there are runtime errors
- You MUST fix all errors before completing`
    : `
WORKFLOW FOR MODIFICATIONS:
1. Use list_files() to see current project structure
2. Read relevant files to understand current state
3. Make your changes with write_file or edit_file
4. Call validate_and_preview() to check for errors
5. If errors found, FIX THEM and validate again
6. ONLY call finish() when validate_and_preview() returns valid: true

CRITICAL RULES:
- finish() will REJECT if you haven't validated
- finish() will REJECT if there are runtime errors
- You MUST fix all errors before completing`;
```

#### 4.2 Add Library Import Guidance
```javascript
const libraryGuidance = `
LIBRARY IMPORT RULES:
1. For ES modules (Three.js, Chart.js, etc.), use import maps:
   <script type="importmap">
   { "imports": { "three": "https://esm.sh/three@0.160.0" } }
   </script>
   <script type="module">
   import * as THREE from 'three';
   </script>

2. NEVER use import statements in non-module scripts
3. If using CDN script tags, use the global variable (e.g., THREE, Chart)
4. Call get_library_docs("libraryname") if unsure about import patterns

COMMON ERRORS TO AVOID:
- "Cannot use import statement outside a module" → Add type="module"
- "X is not defined" → Check import/script order, use importmap
- "Unexpected token 'export'" → Only use export in module scripts`;
```

---

### Phase 5: Server-Side Validation (Supabase Function)

**File:** `supabase/functions/process-job/index.ts`

#### 5.1 Add Post-Completion Validation
```typescript
// After agent signals finish (around line 1509)
if (result.finished) {
    // Validate the generated files before accepting
    const validation = validateGeneratedProject(workingFiles);

    if (!validation.valid) {
        await logger.warn('Agent finished with validation issues', {
            issues: validation.issues
        });

        // If critical issues, don't accept - force another iteration
        if (validation.criticalIssues.length > 0 && iteration < MAX_ITERATIONS - 1) {
            // Add error message and continue loop
            messages.push({
                role: 'user',
                content: `VALIDATION FAILED. You must fix these issues:\n${validation.criticalIssues.join('\n')}\n\nFix the issues and call finish() again.`
            });
            continue; // Don't break, continue iterating
        }
    }

    finished = true;
    finalSummary = result.summary;
    break;
}
```

#### 5.2 Add Server Validation Function
```typescript
function validateGeneratedProject(files: FileResult[]): {
    valid: boolean;
    issues: string[];
    criticalIssues: string[];
} {
    const issues: string[] = [];
    const criticalIssues: string[] = [];

    const htmlFile = files.find(f => f.path === 'index.html');
    if (!htmlFile) {
        criticalIssues.push('Missing index.html');
        return { valid: false, issues, criticalIssues };
    }

    // Check for common errors in generated code
    const allContent = files.map(f => f.content).join('\n');

    // Check for import without module
    const jsFiles = files.filter(f => f.path.endsWith('.js'));
    for (const jsFile of jsFiles) {
        if (/^\s*import\s+/m.test(jsFile.content)) {
            // Check if there's a module script tag in HTML
            const scriptPattern = new RegExp(
                `<script[^>]*src=["']${jsFile.path}["'][^>]*>`,
                'i'
            );
            const match = htmlFile.content.match(scriptPattern);
            if (match && !match[0].includes('type="module"')) {
                criticalIssues.push(
                    `${jsFile.path} uses ES imports but is not loaded as module. Add type="module" to script tag.`
                );
            }
        }
    }

    // Check for undefined library references
    const libraryPatterns = [
        { pattern: /\bTHREE\./g, import: /import.*three/i, name: 'Three.js' },
        { pattern: /\bnew Chart\(/g, import: /import.*chart/i, name: 'Chart.js' },
        { pattern: /\bgsap\./g, import: /import.*gsap/i, name: 'GSAP' },
    ];

    for (const lib of libraryPatterns) {
        if (lib.pattern.test(allContent) && !lib.import.test(allContent)) {
            // Check if loaded via CDN script tag
            const cdnLoaded = /<script[^>]*src=["'][^"']*esm\.sh|unpkg|jsdelivr/i.test(htmlFile.content);
            if (!cdnLoaded) {
                issues.push(`${lib.name} is used but may not be properly imported`);
            }
        }
    }

    return {
        valid: criticalIssues.length === 0,
        issues,
        criticalIssues
    };
}
```

---

### Phase 6: Add Static Analysis Before Render

**File:** `file-ops.js`

#### 6.1 Add Module Consistency Check
```javascript
/**
 * Analyze files for ES module consistency issues
 * Detects when JS uses imports but isn't loaded as module
 */
export function analyzeModuleConsistency(files) {
    const issues = [];
    const htmlFiles = files.filter(f => f.path.endsWith('.html'));
    const jsFiles = files.filter(f => f.path.endsWith('.js'));

    for (const jsFile of jsFiles) {
        const usesImport = /^\s*import\s+/m.test(jsFile.content);
        const usesExport = /^\s*export\s+/m.test(jsFile.content);

        if (usesImport || usesExport) {
            // Find how this JS file is referenced in HTML
            for (const htmlFile of htmlFiles) {
                const scriptPattern = new RegExp(
                    `<script[^>]*src=["'](?:\\.?\\/)?${jsFile.path.replace('./', '')}["']([^>]*)>`,
                    'i'
                );
                const match = htmlFile.content.match(scriptPattern);

                if (match && !match[0].includes('type="module"')) {
                    issues.push({
                        file: jsFile.path,
                        htmlFile: htmlFile.path,
                        type: 'module-mismatch',
                        message: `${jsFile.path} uses ES module syntax but is not loaded with type="module"`,
                        fix: `Change <script src="${jsFile.path}"> to <script type="module" src="${jsFile.path}">`
                    });
                }
            }

            // Check inline scripts that might have issues
            if (jsFile.content.includes('import ') && !jsFile.path.includes('module')) {
                // Inline script detection will be handled by renderer
            }
        }
    }

    return {
        valid: issues.length === 0,
        issues
    };
}
```

#### 6.2 Update validateProjectBeforeFinish to Include Module Check
```javascript
// In agent.js validateProjectBeforeFinish function
const moduleAnalysis = analyzeModuleConsistency(workingFiles);
if (!moduleAnalysis.valid) {
    for (const issue of moduleAnalysis.issues) {
        issues.push(`Module error: ${issue.message}. Fix: ${issue.fix}`);
    }
}
```

---

## Testing Plan

### Unit Tests to Add

```javascript
// tests/module-handling.test.js

describe('Module Script Handling', () => {
    it('should detect ES module syntax', () => {
        expect(isESModule('import * as THREE from "three"')).toBe(true);
        expect(isESModule('export default class Game {}')).toBe(true);
        expect(isESModule('console.log("hello")')).toBe(false);
    });

    it('should inline module scripts with type="module"', () => {
        const files = [{
            path: 'index.html',
            content: '<script type="module" src="script.js"></script>'
        }, {
            path: 'script.js',
            content: 'import * as THREE from "three";'
        }];

        const result = renderToString(files);
        expect(result).toContain('type="module"');
        expect(result).toContain('import * as THREE');
    });

    it('should detect module/script mismatch', () => {
        const files = [{
            path: 'index.html',
            content: '<script src="script.js"></script>'  // Missing type="module"
        }, {
            path: 'script.js',
            content: 'import * as THREE from "three";'
        }];

        const analysis = analyzeModuleConsistency(files);
        expect(analysis.valid).toBe(false);
        expect(analysis.issues[0].type).toBe('module-mismatch');
    });
});

describe('Agent Error Enforcement', () => {
    it('should reject finish() without error check', () => {
        errorCheckPerformed = false;
        const result = executeTool('finish', { summary: 'Done' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('checking for errors');
    });

    it('should reject finish() with runtime errors', () => {
        errorCheckPerformed = true;
        lastPreviewErrors = { hasErrors: true, errors: [{ message: 'THREE is not defined' }] };
        const result = executeTool('finish', { summary: 'Done' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('runtime errors');
    });

    it('should allow finish() when validated and clean', () => {
        errorCheckPerformed = true;
        lastPreviewErrors = { hasErrors: false, errors: [] };
        workingFiles = [{ path: 'index.html', content: '<!DOCTYPE html><html><body></body></html>' }];
        const result = executeTool('finish', { summary: 'Done' });
        expect(result.success).toBe(true);
    });
});
```

---

## Implementation Order

### Priority 1 (Fix Immediately)
1. **Fix module script inlining in renderer.js** - This is causing "Cannot use import statement outside a module"
2. **Add module consistency check** - Catch the issue before render

### Priority 2 (Core Enforcement)
3. **Add error check tracking in agent.js**
4. **Update finish() to require error check**
5. **Make DOM mismatches critical**

### Priority 3 (Enhanced UX)
6. **Add validate_and_preview convenience tool**
7. **Update system prompts with clearer instructions**
8. **Add library import guidance**

### Priority 4 (Server Hardening)
9. **Add server-side validation in process-job**
10. **Add iteration continuation on validation failure**

### Priority 5 (Testing)
11. **Add unit tests for module handling**
12. **Add unit tests for error enforcement**
13. **Add live tests for Three.js/Chart.js generation**

---

## Success Metrics

After implementation:
- [ ] "Cannot use import statement outside a module" errors: 0
- [ ] "X is not defined" errors when library is imported: 0
- [ ] Agent completing with runtime errors: 0
- [ ] Module scripts properly preserve type="module": 100%
- [ ] Error check required before finish(): Enforced
- [ ] All Three.js/Chart.js test generations work: >95%

---

## Files to Modify

| File | Changes |
|------|---------|
| `renderer.js` | Fix module script handling, add isESModule() |
| `agent.js` | Add error enforcement, validate_and_preview tool, tracking vars |
| `file-ops.js` | Add analyzeModuleConsistency() |
| `supabase/functions/process-job/index.ts` | Add server validation, iteration continuation |
| `tests/module-handling.test.js` | New test file |
| `tests/agent-enforcement.test.js` | New test file |

---

## References

- [Evaluating LLM Agents in Multi-Step Workflows](https://www.codeant.ai/blogs/evaluate-llm-agentic-workflows)
- [The 2026 Guide to AI Agent Workflows](https://www.vellum.ai/blog/agentic-workflows-emerging-architectures-and-design-patterns)
- [AI Agentic Programming Survey](https://arxiv.org/html/2508.11126v1)
- [My LLM Coding Workflow - Addy Osmani](https://addyosmani.com/blog/ai-coding-workflow/)

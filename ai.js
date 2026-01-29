import { state } from './state.js';
import { security } from './security.js';

export async function generateProject(prompt, currentFiles) {
    const systemPrompt = `
You are an expert Frontend Developer. Your task is to generate or modify a static website based on the user's prompt.

CONTEXT:
${currentFiles ? "You are modifying an existing project. I will provide the current files. Please update them to fulfill the request. Maintain existing functionality unless asked to change it." : "You are creating a brand new project from scratch."}

OUTPUT FORMAT:
Return strictly valid JSON with no markdown formatting. The JSON must match this schema:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." },
    { "path": "script.js", "content": "..." }
  ],
  "description": "A very brief summary of changes (max 10 words)"
}

REQUIREMENTS:
- Use semantic HTML5.
- Use modern CSS (Flexbox, Grid). You can use 'https://cdn.tailwindcss.com' in the HTML <head> if you want, or write custom CSS.
- Use vanilla JavaScript.
- Images: Use 'https://source.unsplash.com/random/800x600?keyword' (replace keyword) or placeholder colors.
- If modifying, keep the file structure.
- Ensure the design is mobile-responsive.
- Add basic error handling in JS.

USER PROMPT: ${prompt}
    `;

    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
    ];

    if (currentFiles) {
        const contextStr = JSON.stringify(currentFiles);
        const safeContext = contextStr.length > 50000 ? contextStr.substring(0, 50000) + "...(truncated)" : contextStr;
        messages.splice(1, 0, { 
            role: "user", 
            content: `CURRENT FILES:\n${safeContext}\n\nINSTRUCTIONS: Modify these files based on: "${prompt}"` 
        });
    }

    // Always use OpenRouter (BYOK model)
    return await generateWithOpenRouter(messages);
}

async function generateWithOpenRouter(messages) {
    const key = security.getKey();
    if (!key) throw new Error("OpenRouter Key Locked or Missing");

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": window.location.origin,
            "X-Title": "Prompt-to-Site Builder"
        },
        body: JSON.stringify({
            model: state.settings.openRouterModel,
            messages: messages,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(`OpenRouter Error: ${err.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    return JSON.parse(content);
}
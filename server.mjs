#!/usr/bin/env node
// i18n Studio backend. Three jobs: list strings, save an edit (auto), and ask
// Claude for translation candidates. Editing a .ts file makes the running Astro
// dev server hot-reload — that's the whole "hot reload" story, no extra wiring.

// The Claude Agent SDK spawns the Claude Code binary, which prefers ANTHROPIC_API_KEY
// when present. If that env key is unset/invalid, the binary falls back to your
// logged-in Claude Code subscription auth — which is what we want here (no API key
// to manage). We drop a broken/placeholder key so suggestions use your session auth.
if (process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readAll, write, LANGS, STRINGS_DIR } from './strings.mjs';
import { langName, VOICE, PORT } from './config.mjs';

const app = new Hono();

app.get('/api/strings', (c) => c.json({ langs: LANGS, files: readAll() }));

app.post('/api/save', async (c) => {
  const { file, lang, path, value } = await c.req.json();
  try {
    const saved = write(file, lang, path, value);
    return c.json({ ok: true, saved });
  } catch (e) {
    return c.json({ ok: false, error: String(e.message || e) }, 400);
  }
});

app.post('/api/suggest', async (c) => {
  const { sourceText, from, to, path } = await c.req.json();
  if (!sourceText || !LANGS.includes(to)) return c.json({ ok: false, error: 'bad request' }, 400);
  const prompt =
    `You localize UI microcopy. Voice: ${VOICE} ` +
    `Translate the ${langName(from)} source below into ${langName(to)}. ` +
    `PRESERVE all HTML tags and entities exactly (e.g. <b>, <span class="nb">, &nbsp;, &#39;, &mdash;) — same count, same positions relative to the words. ` +
    `Keep it roughly the same length. Do not translate code identifiers or proper nouns. ` +
    `Field key: "${path}".\n\n` +
    `Source (${langName(from)}): ${JSON.stringify(sourceText)}\n\n` +
    `Return ONLY a JSON array of exactly 3 ${langName(to)} candidate strings, most natural first. No prose, no code fences.`;

  try {
    let text = '';
    for await (const msg of query({ prompt, options: { maxTurns: 1, allowedTools: [] } })) {
      if (msg.type === 'result') {
        if (msg.is_error) return c.json({ ok: false, error: msg.result || 'model error' }, 502);
        if (typeof msg.result === 'string') text = msg.result;
      } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        text = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('') || text;
      }
    }
    return c.json({ ok: true, suggestions: parseList(text) });
  } catch (e) {
    return c.json({ ok: false, error: String(e.message || e) }, 500);
  }
});

// Single-page frontend, read from the tool's own dir so it works from any cwd.
app.get('/', (c) => c.html(readFileSync(join(HERE, 'index.html'), 'utf8')));

function parseList(text) {
  if (!text) return [];
  const fence = text.replace(/```json?/gi, '').replace(/```/g, '').trim();
  const start = fence.indexOf('['), end = fence.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(fence.slice(start, end + 1));
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean).slice(0, 5);
    } catch { /* fall through */ }
  }
  // Fallback: non-empty lines, stripped of bullets/quotes.
  return fence.split('\n').map((l) => l.replace(/^[\s\-*\d.]+/, '').replace(/^["']|["'],?$/g, '').trim())
    .filter(Boolean).slice(0, 5);
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`i18n Studio → http://localhost:${info.port}`);
  console.log(`editing:     ${STRINGS_DIR}  (${LANGS.join(', ')})`);
});

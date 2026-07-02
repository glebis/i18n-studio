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
import { readStatus, isAccepted, setAccepted, clearAccepted } from './status.mjs';

const app = new Hono();

// Corpus + review state. Each editable cell gets `accepted` computed from the
// sidecar (true only while the value still matches the accepted hash).
app.get('/api/strings', (c) => {
  const status = readStatus();
  const files = readAll();
  for (const f of files) for (const e of f.entries) for (const lang of LANGS) {
    const cell = e[lang];
    if (cell && cell.editable) cell.accepted = isAccepted(status, f.file, lang, e.path, cell.value);
  }
  return c.json({ langs: LANGS, files });
});

app.post('/api/save', async (c) => {
  const { file, lang, path, value } = await c.req.json();
  try {
    const saved = write(file, lang, path, value);
    clearAccepted(file, lang, path); // an edit drops acceptance back to pending
    return c.json({ ok: true, saved });
  } catch (e) {
    return c.json({ ok: false, error: String(e.message || e) }, 400);
  }
});

// Batch write, used for duplicate propagation ("apply to all N").
app.post('/api/save-many', async (c) => {
  const { edits } = await c.req.json();
  if (!Array.isArray(edits)) return c.json({ ok: false, error: 'edits[] required' }, 400);
  const results = edits.map(({ file, lang, path, value }) => {
    try { write(file, lang, path, value); clearAccepted(file, lang, path); return { ok: true, file, lang, path }; }
    catch (e) { return { ok: false, file, lang, path, error: String(e.message || e) }; }
  });
  return c.json({ ok: true, results });
});

// Toggle review acceptance for one cell (value comes from the client, which
// holds the just-saved on-disk text).
app.post('/api/accept', async (c) => {
  const { file, lang, path, value, accepted } = await c.req.json();
  try { setAccepted(file, lang, path, !!accepted, value); return c.json({ ok: true }); }
  catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 400); }
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

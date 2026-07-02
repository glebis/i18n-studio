// Review state sidecar. The .ts files hold only string values; acceptance
// ("this translation is reviewed and good") is metadata, stored next to the
// strings in `.i18n-status.json`. A cell counts as accepted only while its
// current on-disk value still hashes to the value that was accepted, so any
// later edit silently drops it back to pending.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STRINGS_DIR } from './config.mjs';

const FILE = join(STRINGS_DIR, '.i18n-status.json');
const key = (file, lang, path) => `${file}::${lang}::${path}`;
export const hash = (v) => createHash('sha1').update(String(v)).digest('hex').slice(0, 12);

export function readStatus() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function writeStatus(s) {
  writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
}

// Accepted iff a record exists and matches the value's current hash.
export function isAccepted(status, file, lang, path, value) {
  return status[key(file, lang, path)] === hash(value);
}

export function setAccepted(file, lang, path, accepted, value) {
  const s = readStatus();
  const k = key(file, lang, path);
  if (accepted) s[k] = hash(value); else delete s[k];
  writeStatus(s);
}

// Drop acceptance for a key (called after an edit lands).
export function clearAccepted(file, lang, path) {
  const s = readStatus();
  const k = key(file, lang, path);
  if (k in s) { delete s[k]; writeStatus(s); }
}

/**
 * Isomorphic identifiers: works in the browser and in Node without importing
 * node-specific modules, so @nexus/shared stays usable from both planes.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytesSafe(len: number): Uint8Array {
  const out = new Uint8Array(len);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Time-sortable, URL-safe identifier: `<prefix>_<ts36>_<random>`. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const bytes = randomBytesSafe(10);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${ts}_${rand}`;
}

export function now(): number {
  return Date.now();
}

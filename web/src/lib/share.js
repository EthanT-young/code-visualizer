// Share links (code compressed into the URL hash) and saved drafts.
import { EXAMPLES } from './examples.js';

function toB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** payload: { l: language, c: code, i: stdin } */
export async function encodeShare(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if ('CompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return `z${toB64Url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
  }
  return `p${toB64Url(bytes)}`;
}

export async function decodeShare(hash) {
  const kind = hash[0];
  let bytes = fromB64Url(hash.slice(1));
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (kind !== 'p') {
    throw new Error('unknown link format');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Storage can be unavailable (private mode); drafts are a convenience only.
export function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function saveDraft(lang, code, stdin) {
  save(`cv:code:${lang}`, code);
  save(`cv:stdin:${lang}`, stdin);
  save('cv:lang', lang);
}

/** The saved draft for a language, or its first example. */
export function draftFor(lang) {
  const code = load(`cv:code:${lang}`);
  if (code) return { code, stdin: load(`cv:stdin:${lang}`) || '' };
  const ex = EXAMPLES[lang][0];
  return { code: ex.code, stdin: ex.stdin || '' };
}

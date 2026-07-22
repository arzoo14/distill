'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanForTriggers } = require('./allowlist');

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.distill', 'description-cache.json');
const CACHE_MAX_ENTRIES = 500;

/**
 * Cache so a given server's tool descriptions are compressed once, not on
 * every session start. Keyed by hash of the raw description text, so a server
 * version bump (which changes descriptions) naturally invalidates the cache
 * without any version tracking of our own.
 *
 * Persists to ~/.distill/description-cache.json so the amortization survives
 * process restarts (distill-shrink runs as a child process per session — an
 * in-memory-only cache would pay the compression cost every session, which
 * would contradict docs/HONEST-NUMBERS.md's amortization claim). Writes
 * through synchronously on each new entry for crash-safety; corrupt or
 * missing cache files are treated as empty, never fatal. FIFO-capped so the
 * file can't grow unbounded. Concurrent distill-shrink processes may race on
 * the write — last-writer-wins; worst case is a missed cache entry next
 * session, not a correctness issue.
 */
class DescriptionCache {
  constructor(cachePath = DEFAULT_CACHE_PATH) {
    this.cachePath = cachePath;
    this.map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string') this.map.set(k, v);
        }
      }
    } catch {
      // Missing or corrupt cache file — start empty.
    }
  }

  key(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  get(text) {
    return this.map.get(this.key(text));
  }

  set(text, compressed) {
    this.map.set(this.key(text), compressed);
    while (this.map.size > CACHE_MAX_ENTRIES) {
      this.map.delete(this.map.keys().next().value);
    }
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(Object.fromEntries(this.map)));
    } catch {
      // Cache persistence is best-effort; never fail a compression over it.
    }
  }
}

const globalCache = new DescriptionCache();

// Substitutions, not blind deletions: removing a connective like "in order to"
// or "as well as" outright breaks the sentence ("in order to locate the file"
// must become "to locate the file", not "locate the file"; "X as well as Y"
// must keep its conjunction). Pure-filler phrases map to ''.
const BOILERPLATE_SUBSTITUTIONS = [
  [/\bplease note that\s*/gi, ''],
  [/\bit is important to (note|mention) that\s*/gi, ''],
  [/\bthis tool (can be used to|allows you to|is used to)\s*/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bas well as\b/gi, 'and'],
  [/\bfor example,?\s*/gi, 'e.g. '],
];

/**
 * Compress a single tool/resource description string.
 *
 * Rules:
 *  - Replace known boilerplate phrasing with terse equivalents (never a bare
 *    deletion that changes sentence structure).
 *  - Collapse redundant whitespace.
 *  - NEVER touch a sentence that trips the allowlist (safety/caveat language) —
 *    those are left exactly as written, even if verbose.
 *  - Cached per exact input string.
 *
 * @param {string} description
 * @param {DescriptionCache} [cache]
 * @returns {string} compressed description
 */
function compressDescription(description, cache = globalCache) {
  if (!description || typeof description !== 'string') return description;

  const cached = cache.get(description);
  if (cached !== undefined) return cached;

  const sentences = description
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const compressedSentences = sentences.map((sentence) => {
    const { matched } = scanForTriggers(sentence);
    if (matched) {
      // Protected content: leave untouched, per docs/ALLOWLIST.md
      return sentence;
    }
    let s = sentence;
    for (const [pattern, replacement] of BOILERPLATE_SUBSTITUTIONS) {
      s = s.replace(pattern, replacement);
    }
    return s.replace(/\s+/g, ' ').trim();
  });

  const result = compressedSentences.filter(Boolean).join(' ');
  cache.set(description, result);
  return result;
}

/**
 * Walk an MCP `tools/list` (or `resources/list`) result payload and compress
 * every `description` field found on top-level entries.
 *
 * Note: mutates `listResult` in place and returns the same object.
 *
 * @param {object} listResult - parsed JSON-RPC result payload
 * @returns {{ result: object, stats: { originalChars: number, compressedChars: number } }}
 */
function compressListResult(listResult) {
  let originalChars = 0;
  let compressedChars = 0;

  const items = listResult?.tools || listResult?.resources || [];
  for (const item of items) {
    if (typeof item.description === 'string') {
      originalChars += item.description.length;
      item.description = compressDescription(item.description);
      compressedChars += item.description.length;
    }
    // Compress nested input schema descriptions too, if present.
    const props = item.inputSchema?.properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop && typeof prop.description === 'string') {
          originalChars += prop.description.length;
          prop.description = compressDescription(prop.description);
          compressedChars += prop.description.length;
        }
      }
    }
  }

  return { result: listResult, stats: { originalChars, compressedChars } };
}

module.exports = { compressDescription, compressListResult, DescriptionCache };

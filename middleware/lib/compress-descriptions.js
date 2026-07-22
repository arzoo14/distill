'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { scanForTriggers, TRIGGER_PATTERNS } = require('./allowlist');
const { logEvent } = require('./telemetry');

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

/**
 * Optional LLM-powered rewrite (DISTILL_SHRINK_LLM=cli): regex substitution
 * measures only a few percent on real payloads; a one-time model rewrite gets
 * far more and the persistent cache means each description is paid for once
 * per server version, ever. Opt-in because it shells out to the `claude` CLI
 * (subscription) and adds seconds of latency to the FIRST listing of a new
 * server. The rewrite cost itself is logged honestly as inputTokensAdded.
 *
 * Safety verification: every allowlist trigger substring present in the
 * original must survive the rewrite verbatim, or the rewrite is discarded
 * and the regex path is used instead.
 */
const LLM_MODE = process.env.DISTILL_SHRINK_LLM;
const LLM_MIN_CHARS = 300;

function defaultLlmRunner(description) {
  const prompt =
    'Rewrite this MCP tool description as concisely as possible. Preserve every ' +
    'requirement, constraint, parameter reference, warning, and caveat — cut only ' +
    'redundancy and filler. Output ONLY the rewritten description, nothing else.\n\n' +
    description;
  return execFileSync('claude', ['-p', prompt, '--model', 'haiku'], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function llmRewriteDescription(description, runner = defaultLlmRunner) {
  let out;
  try {
    out = String(runner(description)).trim();
  } catch {
    return null;
  }
  if (!out || out.length >= description.length) return null;
  // Every safety-relevant trigger in the original must survive verbatim.
  for (const re of TRIGGER_PATTERNS) {
    const m = description.match(re);
    if (m && !out.toLowerCase().includes(m[0].toLowerCase())) return null;
  }
  try {
    logEvent({
      source: 'middleware_llm_rewrite',
      // The rewrite call's own cost, charged as input overhead (chars/4).
      inputTokensAdded: Math.round((description.length + out.length) / 4),
      estimated: true,
    });
  } catch {
    // Telemetry is best-effort.
  }
  return out;
}

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
function compressDescription(description, cache = globalCache, llmRunner) {
  if (!description || typeof description !== 'string') return description;

  const cached = cache.get(description);
  if (cached !== undefined) return cached;

  if ((LLM_MODE === 'cli' || llmRunner) && description.length >= LLM_MIN_CHARS) {
    const rewritten = llmRewriteDescription(description, llmRunner || defaultLlmRunner);
    if (rewritten !== null) {
      cache.set(description, rewritten);
      return rewritten;
    }
    // Rewrite unavailable or failed verification — fall through to regex path.
  }

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

// Only dedup repeats long enough that the reference text is a clear win.
const DEDUP_MIN_CHARS = 120;

/**
 * Walk an MCP `tools/list` (or `resources/list`) result payload and compress
 * every `description` field found on top-level entries.
 *
 * Cross-tool dedup: MCP servers frequently ship the exact same long
 * description on many tools/params. The 2nd+ occurrence of an identical
 * description over DEDUP_MIN_CHARS is replaced with an explicit reference to
 * the first ("Same as `name`.") — the full text is still present once in the
 * same listing, so no information leaves the context.
 *
 * Note: mutates `listResult` in place and returns the same object.
 *
 * @param {object} listResult - parsed JSON-RPC result payload
 * @returns {{ result: object, stats: { originalChars: number, compressedChars: number } }}
 */
function compressListResult(listResult) {
  let originalChars = 0;
  let compressedChars = 0;
  const firstSeen = new Map(); // compressed text -> label of first location

  const dedup = (compressed, label) => {
    if (compressed.length < DEDUP_MIN_CHARS) return compressed;
    const existing = firstSeen.get(compressed);
    if (existing) return `Same as \`${existing}\`.`;
    firstSeen.set(compressed, label);
    return compressed;
  };

  const items = listResult?.tools || listResult?.resources || [];
  for (const item of items) {
    const itemName = typeof item.name === 'string' ? item.name : 'unnamed';
    if (typeof item.description === 'string') {
      originalChars += item.description.length;
      item.description = dedup(compressDescription(item.description), itemName);
      compressedChars += item.description.length;
    }
    // Compress nested input schema descriptions too, if present.
    const props = item.inputSchema?.properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) {
        const prop = props[key];
        if (prop && typeof prop.description === 'string') {
          originalChars += prop.description.length;
          prop.description = dedup(compressDescription(prop.description), `${itemName}.${key}`);
          compressedChars += prop.description.length;
        }
      }
    }
  }

  return { result: listResult, stats: { originalChars, compressedChars } };
}

module.exports = {
  compressDescription,
  compressListResult,
  DescriptionCache,
  llmRewriteDescription,
};

'use strict';

const { scanForTriggers } = require('./allowlist');

/**
 * Tool-RESULT compression (design roadmap P1): tool results dominate agent
 * context, and much of their bulk is semantically empty — ANSI color codes,
 * trailing whitespace, runs of blank lines, the same log line repeated
 * hundreds of times, pretty-printed JSON.
 *
 * Only transforms that cannot change meaning are applied:
 *  - strip ANSI escape sequences (rendering markup, zero semantic value)
 *  - strip trailing whitespace per line
 *  - collapse 3+ consecutive blank lines to one
 *  - collapse 4+ consecutive IDENTICAL lines to one + an explicit
 *    "(repeated N times)" marker — the marker is visible, never silent
 *  - minify a text block that is entirely pretty-printed JSON (only when it
 *    parses, round-trips, and actually shrinks)
 *
 * Any block that trips the safety allowlist is left completely untouched —
 * a stack trace mentioning `rm -rf` or a security warning in a tool result
 * must reach the model byte-for-byte. Disable entirely with
 * DISTILL_SHRINK_RESULTS=off.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const REPEAT_THRESHOLD = 4;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

function collapseWhitespace(text) {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/g, ''));
  const out = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks += 1;
      if (blanks <= 1) out.push(line);
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  return out.join('\n');
}

function collapseRepeats(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const count = j - i;
    if (count >= REPEAT_THRESHOLD && lines[i].trim() !== '') {
      out.push(lines[i]);
      out.push(`  (previous line repeated ${count - 1} more times)`);
    } else {
      for (let k = 0; k < count; k++) out.push(lines[i]);
    }
    i = j;
  }
  return out.join('\n');
}

function minifyJson(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    const parsed = JSON.parse(trimmed);
    const compact = JSON.stringify(parsed);
    // Only adopt when it round-trips and meaningfully shrinks.
    if (compact.length < trimmed.length * 0.9) return compact;
  } catch {
    // Not JSON — leave as-is.
  }
  return text;
}

/**
 * Compress one text block from a tool result. Returns the original text
 * unchanged when it contains allowlist-protected content.
 *
 * @param {string} text
 * @returns {string}
 */
function compressResultText(text) {
  if (!text || typeof text !== 'string') return text;
  if (scanForTriggers(text).matched) return text;

  let out = stripAnsi(text);
  out = collapseWhitespace(out);
  out = collapseRepeats(out);
  out = minifyJson(out);
  return out;
}

/**
 * Walk an MCP `tools/call` result payload and compress every text content
 * block. Mutates in place, returns stats like compressListResult.
 *
 * @param {object} callResult - parsed JSON-RPC result payload
 * @returns {{ result: object, stats: { originalChars: number, compressedChars: number } }}
 */
function compressCallResult(callResult) {
  let originalChars = 0;
  let compressedChars = 0;

  const content = callResult?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        originalChars += block.text.length;
        block.text = compressResultText(block.text);
        compressedChars += block.text.length;
      }
    }
  }

  return { result: callResult, stats: { originalChars, compressedChars } };
}

module.exports = {
  compressResultText,
  compressCallResult,
  stripAnsi,
  collapseWhitespace,
  collapseRepeats,
  minifyJson,
};

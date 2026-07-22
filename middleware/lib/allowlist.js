'use strict';

/**
 * Structural allowlist check (see docs/ALLOWLIST.md).
 *
 * This is deliberately NOT semantic — it's a fast, cheap, non-LLM check for
 * syntactically recognizable safety/destructive/caveat language. It exists as a
 * backstop, not a replacement for the model following SKILL.md's instructions.
 */

const TRIGGER_PATTERNS = [
  // Destructive / irreversible actions
  /\brm\s+-rf\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\b/i,
  /--force\b/i,
  /\bforce[- ]push\b/i,
  /\boverwrite(s|d|ing)?\b/i,
  /\brevoke(s|d)?\b/i,
  /\bdelete(s|d)?\s+(all|permanently)\b/i,
  /\birreversible\b/i,
  /\bcannot\s+be\s+undone\b/i,
  /\bpermanently\s+(remove|delete)\b/i,
  /\bwipe(s|d)?\s+(everything|all|data|the\s+(disk|drive|database))\b/i,
  /\berase(s|d)?\s+(all|everything|data)\b/i,
  /\bdata\s+loss\b/i,
  /\bnon[- ]?recoverable\b/i,
  /\bunrecoverable\b/i,
  /\bfactory\s+reset\b/i,
  /\breset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bpurge(s|d)?\s+(all|everything|the\s+(database|table|queue))\b/i,
  /\bwithout\s+(a\s+)?backup\b/i,
  /\bno\s+rollback\b/i,

  // Security language
  /\bvulnerabilit(y|ies)\b/i,
  /\bexploit(able|ed)?\b/i,
  /\bcredential(s)?\s+(exposed|leaked|hard[- ]?coded)\b/i,
  /\binjection\b/i,
  /\bCVE-\d{4}-\d+\b/i,
  /\bunsafe\b/i,

  // Caveat / assumption language
  /\bonly\s+(works|tested|supported)\s+(if|on|when)\b/i,
  /\bassumes?\s+(that\s+)?/i,
  /\bwon'?t\s+work\s+if\b/i,
  /\bdoes\s+not\s+handle\b/i,
  /\bknown\s+limitation\b/i,
];

/**
 * Scan a block of text for allowlist trigger patterns.
 * @param {string} text
 * @returns {{ matched: boolean, patterns: string[] }}
 */
function scanForTriggers(text) {
  if (!text || typeof text !== 'string') {
    return { matched: false, patterns: [] };
  }
  const hits = TRIGGER_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  return { matched: hits.length > 0, patterns: hits };
}

/**
 * Heuristic: was this sentence compressed aggressively relative to a plausible
 * uncompressed baseline? Used to decide whether a triggered sentence needs
 * re-expansion, vs. one that was already stated in full.
 *
 * This is intentionally crude (word-count ratio) — it's a cheap guard, not a
 * precision instrument.
 */
function looksOverCompressed(sentence, estimatedBaselineWordCount) {
  if (!sentence) return false;
  const wordCount = sentence.trim().split(/\s+/).filter(Boolean).length;
  if (!estimatedBaselineWordCount || estimatedBaselineWordCount <= 0) return false;
  return wordCount < estimatedBaselineWordCount * 0.5;
}

module.exports = { scanForTriggers, looksOverCompressed, TRIGGER_PATTERNS };

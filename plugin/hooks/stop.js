#!/usr/bin/env node
'use strict';

/**
 * Stop hook — the structural backstop for SKILL.md's allowlist (design-spec §5)
 * plus skill-side telemetry (Principle B).
 *
 * Enforcement: scan this turn's input context (user prompt + tool results) for
 * allowlist trigger patterns; any trigger whose text does not survive into the
 * final assistant message means protected content was compressed away. In that
 * case exit(2) with the missing sentences on stderr, which blocks the Stop and
 * feeds them back to the model as a forced continuation. Capped at 2
 * consecutive escalations per turn so a persistent miss cannot loop forever.
 *
 * Telemetry: on a clean pass, log an ESTIMATED skill_output event using
 * benchmark-derived reduction ratios (lib/baseline-ratios.js, vendored from
 * middleware/lib/ — kept in sync via plugin/test/run-tests.js) — no live
 * shadow API call. Estimated events are flagged `estimated: true` and
 * reported separately from measured middleware savings by /distill-stats.
 *
 * Scoped to the current turn only, deliberately: a `DROP TABLE` the user
 * pasted three turns ago in an unrelated context is not re-demanded of this
 * response. Every failure path exits 0 — a broken hook must never break the
 * session.
 *
 * Read-only tool results are excluded from the scan (see READONLY_TOOLS):
 * Read/Glob/Grep return file/search content for the agent to observe, not a
 * live warning about an action just taken. Scanning them caused real false
 * positives — e.g. reading allowlist.js during a code review trips on its
 * own `--force` regex literal — that cost real re-expansion tokens without
 * protecting anything, since no live command or MCP call actually happened.
 * Bash and MCP tool_call results stay in scope: those reflect something that
 * actually ran, which is exactly the case this hook exists to catch.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TRIGGER_PATTERNS } = require('../lib/allowlist');
const { logEvent } = require('../lib/telemetry');
const { ratioForBucket } = require('../lib/baseline-ratios');
const { classify } = require('./user-prompt-submit');

const STATE_FILE = path.join(os.homedir(), '.distill', 'session-state.json');
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'distill', 'SKILL.md');
const MAX_TRANSCRIPT_LINES = 200;
const MAX_ESCALATIONS = 2;

// Observational, non-mutating tools: their results are file/search content
// for the agent to read, not the outcome of an action. Excluded from the
// allowlist scan — see the file-header comment for why.
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * Map each tool_use id to its tool name by scanning assistant records once.
 * Needed because the transcript walk in extractTurnContext goes backward and
 * would otherwise reach a tool_result before the tool_use that named it.
 *
 * @param {string[]} lines - JSONL lines
 * @returns {Map<string, string>}
 */
function buildToolNameMap(lines) {
  const map = new Map();
  for (const raw of lines) {
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (record?.type !== 'assistant') continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
        map.set(part.id, part.name);
      }
    }
  }
  return map;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { mode: 'adaptive' };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort.
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && part.type === 'tool_result') return textFromContent(part.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Walk transcript lines backward from the end to the nearest real user
 * message (a user record containing actual text, not a tool-result-only
 * record), collecting tool_result text along the way. Returns this turn's
 * input context.
 *
 * @param {string[]} lines - JSONL lines, oldest first
 * @returns {{ userText: string, toolResultText: string, lastAssistantUsage: object|null }}
 */
function extractTurnContext(lines) {
  const recent = lines.slice(-MAX_TRANSCRIPT_LINES);
  const toolNameById = buildToolNameMap(recent);
  let userText = '';
  const toolResults = [];
  let lastAssistantUsage = null;

  for (let i = recent.length - 1; i >= 0; i--) {
    let record;
    try {
      record = JSON.parse(recent[i]);
    } catch {
      continue;
    }
    const message = record?.message;
    if (!message) continue;

    if (record.type === 'assistant' && !lastAssistantUsage && message.usage) {
      lastAssistantUsage = message.usage;
    }

    if (record.type !== 'user') continue;

    const content = message.content;
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    const toolResultParts = parts.filter((p) => p && p.type === 'tool_result');
    const textParts = parts.filter(
      (p) => p && (typeof p === 'string' || (p.type === 'text' && typeof p.text === 'string'))
    );

    for (const tr of toolResultParts) {
      const toolName = tr && typeof tr.tool_use_id === 'string' ? toolNameById.get(tr.tool_use_id) : undefined;
      if (toolName && READONLY_TOOLS.has(toolName)) continue;
      toolResults.push(textFromContent(tr.content));
    }
    if (textParts.length > 0) {
      // Nearest real user message — this turn's boundary.
      userText = textParts.map((p) => (typeof p === 'string' ? p : p.text)).join('\n');
      break;
    }
  }

  return { userText, toolResultText: toolResults.join('\n'), lastAssistantUsage };
}

/**
 * Find allowlist-protected sentences from the input context whose trigger
 * text did not survive into the final assistant message.
 *
 * The presence check is on the specific trigger substring, not the whole
 * sentence — the model may legitimately rephrase around a warning, but the
 * operative token (`rm -rf`, `irreversible`, ...) must still be there.
 *
 * @param {string} contextText
 * @param {string} finalText
 * @returns {{ sentence: string, trigger: string }[]}
 */
function findProtectedMisses(contextText, finalText) {
  if (!contextText || typeof contextText !== 'string') return [];
  const finalLower = (finalText || '').toLowerCase();

  const sentences = contextText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const misses = [];
  const seenTriggers = new Set();
  for (const sentence of sentences) {
    for (const re of TRIGGER_PATTERNS) {
      const match = sentence.match(re);
      if (!match) continue;
      const trigger = match[0];
      const key = trigger.toLowerCase();
      if (seenTriggers.has(key)) continue;
      seenTriggers.add(key);
      if (!finalLower.includes(key)) {
        misses.push({ sentence, trigger });
      }
    }
  }
  return misses;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const finalText = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!finalText) process.exit(0);

  let lines = [];
  try {
    lines = fs.readFileSync(input.transcript_path, 'utf8').split('\n').filter(Boolean);
  } catch {
    process.exit(0);
  }

  const { userText, toolResultText, lastAssistantUsage } = extractTurnContext(lines);
  const state = readState();

  // --- Gap 1: allowlist enforcement ---
  const misses = findProtectedMisses([userText, toolResultText].filter(Boolean).join('\n'), finalText);
  const attempts = state.allowlistEscalationAttempts || 0;

  if (misses.length > 0) {
    if (attempts < MAX_ESCALATIONS) {
      state.allowlistEscalationAttempts = attempts + 1;
      writeState(state);
      if (attempts === 0) {
        logEvent({
          source: 'stop_hook_allowlist_check',
          allowlistReexpansionTriggered: true,
          reexpansionCostTokens: Math.round(finalText.length / 4),
          estimated: true,
        });
      }
      const listing = misses
        .map((m) => `- "${m.sentence}" (trigger: "${m.trigger}")`)
        .join('\n');
      process.stderr.write(
        'Distill allowlist check: this turn\'s context contains protected ' +
          'safety/destructive-action content that is missing from your response. ' +
          'Restore the following, stated in full (do not compress them), then ' +
          'finish your response:\n' + listing + '\n'
      );
      process.exit(2);
    }
    // 3rd consecutive miss: a classifier gap or a false positive — log it and
    // let the turn end rather than looping forever.
    state.allowlistEscalationAttempts = 0;
    writeState(state);
    logEvent({
      source: 'stop_hook_allowlist_check',
      allowlistEscalationGaveUp: true,
      estimated: true,
    });
    process.exit(0);
  }

  if (attempts > 0) {
    state.allowlistEscalationAttempts = 0;
  }

  // --- Gap 2: estimated skill-side telemetry (skip when disabled) ---
  if (state.mode !== 'off') {
    const bucket = classify(userText || '');
    const outputTokensActual =
      typeof lastAssistantUsage?.output_tokens === 'number'
        ? lastAssistantUsage.output_tokens
        : Math.round(finalText.length / 4);
    const ratio = ratioForBucket(bucket);
    const outputTokensBaseline = Math.round(outputTokensActual / (1 - ratio));

    let inputTokensAdded = 0;
    if (!state.skillOverheadChargedThisSession) {
      try {
        inputTokensAdded = Math.round(fs.readFileSync(SKILL_PATH, 'utf8').length / 4);
      } catch {
        inputTokensAdded = 0;
      }
      state.skillOverheadChargedThisSession = true;
    }

    logEvent({
      source: 'skill_output',
      outputTokensBaseline,
      outputTokensActual,
      inputTokensAdded,
      estimated: true,
      taskBucket: bucket,
    });
  }

  writeState(state);
  process.exit(0);
}

module.exports = { extractTurnContext, findProtectedMisses };

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook.
 *
 * Provides a cheap, local (non-LLM) hint about this turn's likely complexity,
 * so SKILL.md's adaptive compression has a signal to work with beyond the
 * model's own judgment. This is a hint, not a hard rule — the model still
 * makes the final call per SKILL.md.
 *
 * Also maintains the adaptive back-off counter (Principle D): consecutive
 * clarification-shaped prompts are a signal the previous compressed answer
 * cut too much, so the emitted hint steps down one level until a normal
 * prompt ends the streak.
 *
 * Kept intentionally tiny: a few regex checks, not a classifier model, so it
 * doesn't itself become a token/latency cost.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.distill', 'session-state.json');

const COMPLEX_SIGNALS = [
  /\bdebug\b/i,
  /\barchitecture\b/i,
  /\btrade[- ]?off/i,
  /\bwhy (is|does|isn'?t|doesn'?t)\b/i,
  /\bprove\b/i,
  /\bderive\b/i,
  /\bdesign\b/i,
];

const SIMPLE_SIGNALS = [
  /^\s*(yes|no|ok|okay|sure|thanks?)\s*[.!]?\s*$/i,
  /\bcommit message\b/i,
  /\bstatus\b/i,
  /\bwhat'?s the (value|status|result)\b/i,
];

// A prompt that reads as "your last answer lost me" — the signal SKILL.md's
// adaptive table uses to back off one compression level.
const CLARIFICATION_SIGNALS = [
  /\bwhat did you mean\b/i,
  /\bwhat do you mean\b/i,
  /\bcan you (clarify|explain that|elaborate)\b/i,
  /\bi don'?t (understand|follow|get it)\b/i,
  /\bnot sure what you mean\b/i,
  /\bcome again\b/i,
  /^\s*what\?+\s*$/i,
  /^\s*huh\?*\s*$/i,
];

function classify(promptText) {
  if (SIMPLE_SIGNALS.some((re) => re.test(promptText))) return 'simple';
  if (COMPLEX_SIGNALS.some((re) => re.test(promptText))) return 'complex';
  return 'moderate';
}

function isClarification(promptText) {
  return CLARIFICATION_SIGNALS.some((re) => re.test(promptText));
}

// One step less compression: simple -> moderate -> complex (floor).
function stepDown(hint) {
  if (hint === 'simple') return 'moderate';
  return 'complex';
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { mode: 'adaptive', consecutiveClarifications: 0 };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // State persistence is best-effort; a failed write must not block the turn.
  }
}

function readPromptText() {
  // Claude Code delivers hook input as JSON on stdin ({ prompt: "..." }).
  // The env var is a fallback for agents/tests that invoke this directly.
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) {
      const parsed = JSON.parse(stdin);
      if (typeof parsed.prompt === 'string') return parsed.prompt;
    }
  } catch {
    // Fall through to env.
  }
  return process.env.DISTILL_PROMPT_TEXT || '';
}

function main() {
  const promptText = readPromptText();
  const state = readState();

  // If the user is overriding mode explicitly this turn, respect it and don't
  // print the hint (avoid double-signaling). No state change either — the
  // /distill script owns state on override turns.
  if (/^\/distill\b/i.test(promptText.trim())) {
    return;
  }

  const clarification = isClarification(promptText);
  state.consecutiveClarifications = clarification
    ? (state.consecutiveClarifications || 0) + 1
    : 0;
  writeState(state);

  // Explicitly disabled — stay silent, no hint noise.
  if (state.mode === 'off') {
    return;
  }

  let hint = classify(promptText);
  if (state.consecutiveClarifications > 0) {
    hint = stepDown(hint);
    process.stdout.write(
      `distill_turn_hint: ${hint} (back off: ${state.consecutiveClarifications} consecutive clarification${state.consecutiveClarifications === 1 ? '' : 's'})\n`
    );
    return;
  }

  // Emit a single, terse line the agent can read as context — not a
  // multi-paragraph instruction re-injection.
  process.stdout.write(`distill_turn_hint: ${hint}\n`);
}

module.exports = { classify, isClarification, stepDown };

if (require.main === module) {
  main();
}

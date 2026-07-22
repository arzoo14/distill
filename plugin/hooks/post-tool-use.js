#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook (matcher: Edit|Write) — memory-file compaction trigger
 * (design-spec Principle A, "Memory files").
 *
 * Strictly opt-in: does nothing unless `/distill autocompact on` has set
 * state.autoCompactMemoryFiles. When enabled and a watched memory file
 * (default: CLAUDE.md) is edited, emits a non-blocking nudge asking the agent
 * to apply SKILL.md's semantic compression to it — hooks can't rewrite the
 * file themselves, and shouldn't. Debounced by file size and a cooldown so an
 * edit→nudge→edit loop can't chatter on every keystroke.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.distill', 'session-state.json');
const MIN_SIZE_BYTES = 2000;
const COOLDOWN_MS = 10 * 60 * 1000;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
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

function watchedBasenames(state) {
  const globs = Array.isArray(state.memoryFileGlobs) ? state.memoryFileGlobs : ['CLAUDE.md'];
  // Basename match only — no glob engine needed for a list of filenames.
  return globs.map((g) => path.basename(String(g)).toLowerCase());
}

/**
 * Decide whether an edit to filePath deserves a compaction nudge.
 * Pure-ish (fs/size injectable) so it's unit-testable.
 *
 * @param {string} filePath
 * @param {object} state
 * @param {{ sizeOf?: (p: string) => number, now?: number }} [deps]
 * @returns {boolean}
 */
function shouldNudge(filePath, state, { sizeOf, now = Date.now() } = {}) {
  if (!state.autoCompactMemoryFiles) return false;
  if (!filePath || typeof filePath !== 'string') return false;
  if (!watchedBasenames(state).includes(path.basename(filePath).toLowerCase())) return false;

  const size = sizeOf
    ? sizeOf(filePath)
    : (() => {
        try {
          return fs.statSync(filePath).size;
        } catch {
          return 0;
        }
      })();
  if (size < MIN_SIZE_BYTES) return false;

  const last = Date.parse(state.lastAutoCompactNudgeAt || '') || 0;
  if (now - last < COOLDOWN_MS) return false;

  return true;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const state = readState();
  if (!state.autoCompactMemoryFiles) process.exit(0);

  const filePath = input.tool_input?.file_path || input.tool_response?.filePath || '';
  if (!shouldNudge(filePath, state)) process.exit(0);

  state.lastAutoCompactNudgeAt = new Date().toISOString();
  writeState(state);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `${path.basename(filePath)} changed and auto-compact is enabled — apply ` +
          "SKILL.md's semantic compression to it, preserving anything matched by " +
          'docs/ALLOWLIST.md verbatim.',
      },
    }) + '\n'
  );
  process.exit(0);
}

module.exports = { shouldNudge, watchedBasenames };

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

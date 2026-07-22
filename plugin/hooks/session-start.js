#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook.
 *
 * Deliberately does almost nothing at startup — the instruction overhead
 * problem (limitation #5) comes from re-injecting a large prompt every turn.
 * This hook just seeds a tiny state file; SKILL.md's adaptive logic reads
 * task shape per-turn instead of relying on a large always-loaded preamble.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.distill');
const STATE_FILE = path.join(STATE_DIR, 'session-state.json');

function main() {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }

    const initialState = {
      mode: 'adaptive', // adaptive | light | deep | off — overridden by /distill
      consecutiveClarifications: 0, // used to auto-back-off if we compressed too far
      autoCompactMemoryFiles: false, // opt-in via `/distill autocompact on`
      memoryFileGlobs: ['CLAUDE.md'], // basenames watched by the PostToolUse hook
      skillOverheadChargedThisSession: false, // skill footprint logged once per session
      allowlistEscalationAttempts: 0, // Stop-hook escalation loop guard
      sessionStartedAt: new Date().toISOString(),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2));
  } catch {
    // State seeding is best-effort; never block session start.
  }

  // Minimal stdout — this hook's own output shouldn't add to the token bill
  // it's trying to reduce.
  console.log('distill: adaptive mode active');
}

main();

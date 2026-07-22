#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.distill', 'session-state.json');
const VALID_MODES = ['adaptive', 'light', 'deep', 'off'];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { mode: 'adaptive', consecutiveClarifications: 0 };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function main() {
  const arg = (process.argv[2] || '').toLowerCase().trim();
  const state = readState();

  if (!arg) {
    console.log(
      `distill mode: ${state.mode}` +
        (state.autoCompactMemoryFiles ? ' (memory-file autocompact: on)' : '')
    );
    return;
  }

  if (arg === 'autocompact') {
    const toggle = (process.argv[3] || '').toLowerCase().trim();
    if (toggle !== 'on' && toggle !== 'off') {
      console.log('Usage: /distill autocompact on|off');
      process.exitCode = 1;
      return;
    }
    state.autoCompactMemoryFiles = toggle === 'on';
    writeState(state);
    console.log(`distill memory-file autocompact: ${toggle}`);
    return;
  }

  if (!VALID_MODES.includes(arg)) {
    console.log(
      `Unknown mode "${arg}". Valid modes: ${VALID_MODES.join(', ')} (adaptive is the recommended default), or "autocompact on|off".`
    );
    process.exitCode = 1;
    return;
  }

  state.mode = arg;
  state.consecutiveClarifications = 0;
  writeState(state);
  console.log(`distill mode set to: ${arg}`);
}

main();

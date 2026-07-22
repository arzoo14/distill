#!/usr/bin/env node
'use strict';

/**
 * /distill-compact [file]
 *
 * On-demand compaction of a project memory file (CLAUDE.md, notes, etc.).
 * Deliberately NOT run automatically every session start — that would re-add
 * the "overhead that eats the savings" problem (limitation #5). Instead this
 * runs on explicit request or should be wired to a file-change hook by the
 * user if they want it automatic.
 *
 * This script does not itself call an LLM — it delegates the actual rewrite
 * to the agent (the agent should read the target file and apply SKILL.md's
 * semantic-compression rules to it, respecting the allowlist for any
 * warnings/caveats documented in the file). This script just resolves the
 * target path and prints it for the agent to act on.
 */

const fs = require('fs');
const path = require('path');

function main() {
  const target = process.argv[2] || 'CLAUDE.md';
  const resolved = path.resolve(process.cwd(), target);

  if (!fs.existsSync(resolved)) {
    console.log(`distill-compact: no file found at ${resolved}`);
    process.exitCode = 1;
    return;
  }

  const stat = fs.statSync(resolved);
  console.log(`distill-compact: target ${resolved} (${stat.size} bytes)`);
  console.log(
    'Agent: apply SKILL.md semantic compression to this file. Preserve every ' +
      'sentence matched by the allowlist (docs/ALLOWLIST.md) verbatim. Report ' +
      'before/after byte counts when done.'
  );
}

main();

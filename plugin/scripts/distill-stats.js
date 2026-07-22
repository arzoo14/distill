#!/usr/bin/env node
'use strict';

const { summarize } = require('../../middleware/lib/telemetry');

function main() {
  const s = summarize();

  console.log('Distill — session savings (net, not output-only)');
  console.log('--------------------------------------------------');
  console.log(`Events logged:            ${s.events}`);
  console.log('');
  console.log('MEASURED (middleware — real character counts):');
  console.log(`  Output tokens saved:    ${s.measured.outputTokensSaved}`);
  console.log(`  Input tokens added:     ${s.measured.inputTokensAdded}`);
  console.log(`  Net delta:              ${s.measured.netDelta}`);
  console.log('');
  console.log('ESTIMATED (skill — benchmark-derived ratio, not directly measured):');
  console.log(`  Output tokens saved:    ${s.estimated.outputTokensSaved}`);
  console.log(`  Input tokens added:     ${s.estimated.inputTokensAdded}  (skill overhead)`);
  console.log(`  Net delta:              ${s.estimated.netDelta}`);
  console.log('');
  console.log(`COMBINED net token delta: ${s.netDelta}${s.netDelta < 0 ? '  (net-negative this session — see docs/HONEST-NUMBERS.md)' : ''}`);
  console.log(`Allowlist re-expansions:  ${s.allowlistReexpansions} (cost: ${s.reexpansionCostTokens} tokens, tracked separately)`);
}

main();

#!/usr/bin/env node
'use strict';

const { summarize } = require('../../middleware/lib/telemetry');

// Pricing for the dollar estimates below (USD per million tokens). Defaults
// are Claude Sonnet rates; override via env for other models/plans.
const INPUT_PER_MTOK = Number(process.env.DISTILL_PRICE_INPUT_MTOK) || 3;
const OUTPUT_PER_MTOK = Number(process.env.DISTILL_PRICE_OUTPUT_MTOK) || 15;

function usd(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(4)}`;
}

function main() {
  const s = summarize();
  const outputSavedUsd = (s.outputTokensSaved * OUTPUT_PER_MTOK) / 1e6;
  const inputAddedUsd = (s.inputTokensAdded * INPUT_PER_MTOK) / 1e6;
  const netUsd = outputSavedUsd - inputAddedUsd;

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
  console.log(
    `COMBINED net cost delta:  ${usd(netUsd)}  (at $${INPUT_PER_MTOK}/$${OUTPUT_PER_MTOK} per Mtok in/out — override with DISTILL_PRICE_INPUT_MTOK / DISTILL_PRICE_OUTPUT_MTOK)`
  );
  console.log(`Allowlist re-expansions:  ${s.allowlistReexpansions} (cost: ${s.reexpansionCostTokens} tokens, tracked separately)`);

  // Honesty-as-a-feature: if the numbers say this workload doesn't benefit,
  // say so instead of hoping the user never checks.
  if (s.events >= 10 && s.netDelta <= 0) {
    console.log('');
    console.log(
      `NOTE: net delta is ${s.netDelta <= 0 ? 'non-positive' : ''} across ${s.events} events — ` +
        'this workload may not benefit from output-side compression. Consider ' +
        '`/distill off` (middleware input-side savings continue regardless).'
    );
  }
}

main();

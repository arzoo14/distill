#!/usr/bin/env node
'use strict';

/**
 * Distill benchmark runner.
 *
 * Measures REAL token counts from the Anthropic API for each prompt in
 * prompts.json, run twice: once with no Distill system prompt (baseline)
 * and once with SKILL.md prepended as the system prompt (distilled).
 *
 * Reports, per docs/HONEST-NUMBERS.md's methodology, ALL of:
 *   - output tokens: baseline vs distilled, and % reduction
 *   - input tokens: baseline vs distilled (the skill's own overhead shows up here)
 *   - net delta = output_saved - input_added
 *
 * Requires ANTHROPIC_API_KEY in the environment. Does not run automatically
 * as part of install — this is a `npm run benchmark` / manual step so you can
 * reproduce the numbers yourself against your own key.
 */

const fs = require('fs');
const path = require('path');

const MODEL = 'claude-sonnet-5';
const SKILL_PATH = path.join(__dirname, '..', 'plugin', 'skills', 'distill', 'SKILL.md');
const PROMPTS_PATH = path.join(__dirname, 'prompts.json');

async function callClaude({ system, userPrompt }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Export it before running benchmarks.');
  }

  const body = {
    model: MODEL,
    max_tokens: 1024,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: userPrompt }],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return {
    outputTokens: data.usage?.output_tokens ?? 0,
    inputTokens: data.usage?.input_tokens ?? 0,
  };
}

async function runOne(promptCase, skillText) {
  const baseline = await callClaude({ system: undefined, userPrompt: promptCase.prompt });
  const distilled = await callClaude({ system: skillText, userPrompt: promptCase.prompt });

  const outputTokensSaved = baseline.outputTokens - distilled.outputTokens;
  const inputTokensAdded = distilled.inputTokens - baseline.inputTokens;
  const netDelta = outputTokensSaved - inputTokensAdded;

  return {
    id: promptCase.id,
    tag: promptCase.tag,
    baselineOutputTokens: baseline.outputTokens,
    distilledOutputTokens: distilled.outputTokens,
    outputReductionPct:
      baseline.outputTokens > 0
        ? Math.round((outputTokensSaved / baseline.outputTokens) * 1000) / 10
        : 0,
    inputTokensAdded,
    netDelta,
  };
}

async function main() {
  const prompts = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
  const skillText = fs.readFileSync(SKILL_PATH, 'utf8');

  console.log(`Running ${prompts.length} prompt(s) against ${MODEL}...\n`);

  const results = [];
  for (const p of prompts) {
    process.stdout.write(`  ${p.id} (${p.tag})... `);
    try {
      const r = await runOne(p, skillText);
      results.push(r);
      console.log(
        `output ${r.baselineOutputTokens}->${r.distilledOutputTokens} tok ` +
          `(${r.outputReductionPct}%), input +${r.inputTokensAdded}, net ${r.netDelta >= 0 ? '+' : ''}${r.netDelta}`
      );
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  const totalOutputSaved = results.reduce(
    (sum, r) => sum + (r.baselineOutputTokens - r.distilledOutputTokens),
    0
  );
  const totalInputAdded = results.reduce((sum, r) => sum + r.inputTokensAdded, 0);
  const totalNet = totalOutputSaved - totalInputAdded;

  console.log('\n--- Summary (honest, net-first — see docs/HONEST-NUMBERS.md) ---');
  console.log(`Total output tokens saved:  ${totalOutputSaved}`);
  console.log(`Total input tokens added:   ${totalInputAdded}  (skill overhead)`);
  console.log(`NET token delta:            ${totalNet}`);

  const adversarial = results.filter((r) => r.tag === 'adversarial');
  const adversarialNet = adversarial.reduce(
    (sum, r) => sum + (r.baselineOutputTokens - r.distilledOutputTokens - r.inputTokensAdded),
    0
  );
  console.log(
    `Adversarial-case net delta: ${adversarialNet}` +
      (adversarialNet < 0 ? '  (net-negative on adversarial cases, as expected — see docs/HONEST-NUMBERS.md)' : '')
  );

  fs.writeFileSync(
    path.join(__dirname, 'last-run-results.json'),
    JSON.stringify(results, null, 2)
  );
  console.log('\nFull results written to benchmarks/last-run-results.json');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

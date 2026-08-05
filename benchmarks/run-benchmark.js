#!/usr/bin/env node
'use strict';

/**
 * Distill benchmark runner.
 *
 * Measures REAL output token counts for each prompt in prompts.json across
 * multiple arms:
 *
 *   - baseline:         no system prompt
 *   - distill-adaptive: SKILL.md as system prompt (default mode)
 *   - distill-deep:     SKILL.md with /distill deep forced (telegraphic +
 *                       allowlist protection)
 *   - compare:          optional external skill/prompt file, e.g. another
 *                       compression tool's instructions, via
 *                       DISTILL_BENCH_COMPARE_SKILL=/path/to/SKILL.md
 *
 * Reports, per docs/HONEST-NUMBERS.md's methodology: output reduction per
 * arm, input overhead added by each arm's instructions, and net delta.
 *
 * Two measurement modes, auto-selected:
 *
 * - API mode (ANTHROPIC_API_KEY set): direct Messages API calls. Cleanest
 *   numbers — no harness system prompt in either arm.
 * - CLI mode (no key, `claude` CLI installed): runs each prompt through
 *   `claude -p --output-format json` on your Claude subscription — no API
 *   credits needed. Output tokens are real API-measured usage. Input
 *   overhead is a deterministic chars/4 estimate of each arm's instruction
 *   text (prompt-cache flapping between arms makes measured input deltas
 *   pure noise). Set DISTILL_BENCH_SETTINGS to a settings JSON string (e.g.
 *   '{"enabledPlugins":{"someplugin@marketplace":false}}') to disable
 *   plugins that would otherwise inject style instructions into the
 *   measurement.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MODEL = 'claude-sonnet-5';
const SKILL_PATH = path.join(__dirname, '..', 'plugin', 'skills', 'distill', 'SKILL.md');
const PROMPTS_PATH = path.join(__dirname, 'prompts.json');

function detectMode() {
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' });
    return 'cli';
  } catch {
    throw new Error(
      'No ANTHROPIC_API_KEY set and no `claude` CLI found. Provide one of the two.'
    );
  }
}

async function callClaudeApi({ system, userPrompt }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const body = {
    model: MODEL,
    max_tokens: 2048,
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

function callClaudeCli({ system, userPrompt, cwd }) {
  const args = ['-p', userPrompt, '--output-format', 'json', '--model', MODEL];
  if (system) args.push('--append-system-prompt', system);
  if (process.env.DISTILL_BENCH_SETTINGS) {
    args.push('--settings', process.env.DISTILL_BENCH_SETTINGS);
  }
  const stdout = execFileSync('claude', args, {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    // Run from a neutral, empty directory — not the Distill repo. With cwd
    // left at the repo root, the model can (and does) read its own
    // benchmarks/prompts.json or test fixtures, recognize the prompt as a
    // known eval case, and respond to being tested instead of answering
    // naturally. That's real, observed contamination (both arms opened with
    // "this is the destructive-op-confirmation benchmark prompt..." instead
    // of answering), not a hypothetical.
    cwd,
  });
  const data = JSON.parse(stdout);
  if (data.is_error) {
    throw new Error(`CLI error: ${String(data.result).slice(0, 200)}`);
  }
  const u = data.usage || {};
  return {
    outputTokens: u.output_tokens ?? 0,
    // Input counts are NOT taken from CLI usage — see header comment.
    inputTokens: 0,
  };
}

async function callClaude(mode, { system, userPrompt, cwd }) {
  return mode === 'api'
    ? callClaudeApi({ system, userPrompt })
    : callClaudeCli({ system, userPrompt, cwd });
}

function buildArms(skillText) {
  const arms = [
    { key: 'distilled', label: 'distill-adaptive', system: skillText },
    {
      key: 'deep',
      label: 'distill-deep',
      system:
        skillText +
        '\n\n[Session override] /distill deep is active for this entire session — ' +
        'use deep mode for every response.',
    },
  ];
  const comparePath = process.env.DISTILL_BENCH_COMPARE_SKILL;
  if (comparePath) {
    arms.push({
      key: 'compare',
      label: `compare:${path.basename(comparePath)}`,
      system: fs.readFileSync(comparePath, 'utf8'),
    });
  }
  return arms;
}

function pct(baseline, actual) {
  return baseline > 0 ? Math.round(((baseline - actual) / baseline) * 1000) / 10 : 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Run one prompt `repeats` times against one system prompt; return the median
 * output tokens plus the raw samples. Model output length varies heavily
 * run-to-run — single samples flipped sign between whole benchmark runs, so
 * medians over n>=3 are the only per-case numbers worth quoting.
 */
async function sampleArm(mode, system, userPrompt, repeats, cwd) {
  const samples = [];
  let inputTokens = 0;
  for (let i = 0; i < repeats; i++) {
    const r = await callClaude(mode, { system, userPrompt, cwd });
    samples.push(r.outputTokens);
    inputTokens = r.inputTokens;
  }
  return { outputTokens: median(samples), samples, inputTokens };
}

async function runOne(mode, promptCase, arms, repeats, cwd) {
  const baseline = await sampleArm(mode, undefined, promptCase.prompt, repeats, cwd);
  const result = {
    id: promptCase.id,
    tag: promptCase.tag,
    baselineOutputTokens: baseline.outputTokens,
  };
  if (repeats > 1) result.baselineOutputTokensSamples = baseline.samples;

  for (const arm of arms) {
    const r = await sampleArm(mode, arm.system, promptCase.prompt, repeats, cwd);
    result[`${arm.key}OutputTokens`] = r.outputTokens;
    result[`${arm.key}ReductionPct`] = pct(baseline.outputTokens, r.outputTokens);
    if (repeats > 1) result[`${arm.key}OutputTokensSamples`] = r.samples;
    const overhead =
      mode === 'api'
        ? r.inputTokens - baseline.inputTokens
        : Math.round(arm.system.length / 4);
    result[`${arm.key}InputTokensAdded`] = overhead;

    if (arm.key === 'distilled') {
      // Legacy field names consumed by middleware/lib/baseline-ratios.js and
      // earlier results files — keep them stable.
      result.outputReductionPct = result.distilledReductionPct;
      result.inputTokensAdded = overhead;
      result.netDelta = baseline.outputTokens - r.outputTokens - overhead;
    }
  }
  return result;
}

function parseRepeats() {
  const argIdx = process.argv.indexOf('--repeats');
  const raw =
    argIdx !== -1 ? process.argv[argIdx + 1] : process.env.DISTILL_BENCH_REPEATS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 9) : 1;
}

// Comma-separated prompt ids to run, e.g. --only math-proof,single-fact-question.
// For re-running just the cases that errored (rate limits, transient CLI
// failures) without re-spending calls on ones that already succeeded.
function parseOnly() {
  const argIdx = process.argv.indexOf('--only');
  const raw = argIdx !== -1 ? process.argv[argIdx + 1] : process.env.DISTILL_BENCH_ONLY;
  if (!raw) return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

async function main() {
  const mode = detectMode();
  const repeats = parseRepeats();
  const only = parseOnly();
  let prompts = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
  if (only) {
    prompts = prompts.filter((p) => only.has(p.id));
    const missing = [...only].filter((id) => !prompts.some((p) => p.id === id));
    if (missing.length > 0) {
      console.error(`Unknown --only id(s): ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  const skillText = fs.readFileSync(SKILL_PATH, 'utf8');
  const arms = buildArms(skillText);

  console.log(
    `Running ${prompts.length} prompt(s) x ${arms.length + 1} arms x ${repeats} repeat(s) against ${MODEL} (${mode} mode)...`
  );
  if (repeats === 1) {
    console.log(
      '  NOTE: single-sample run — per-case numbers are noisy. Use --repeats 3\n' +
        '  (or DISTILL_BENCH_REPEATS=3) for median-based numbers worth quoting.'
    );
  }
  console.log(`  Arms: baseline, ${arms.map((a) => a.label).join(', ')}`);
  if (mode === 'cli') {
    console.log(
      '  CLI mode: measured via your Claude subscription. Output tokens are real\n' +
        '  usage; input overhead is a deterministic chars/4 estimate of each\n' +
        "  arm's instruction text.\n"
    );
  } else {
    console.log('');
  }

  // CLI mode spawns `claude -p` as a real subprocess with a real cwd, and it
  // has file access there. Running it from the repo root let the model read
  // benchmarks/prompts.json or test fixtures, recognize the prompt as a known
  // eval case, and respond to being tested instead of answering naturally —
  // observed directly (both distill and a comparison arm opened with "this
  // is the destructive-op-confirmation benchmark prompt..." rather than
  // answering). An empty temp dir has nothing for the model to find.
  let neutralCwd;
  if (mode === 'cli') {
    neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-bench-'));
  }

  const results = [];
  let errors = 0;
  try {
    for (const p of prompts) {
      process.stdout.write(`  ${p.id} (${p.tag})... `);
      try {
        const r = await runOne(mode, p, arms, repeats, neutralCwd);
        results.push(r);
        const spread = (key) =>
          repeats > 1
            ? ` [${Math.min(...r[`${key}OutputTokensSamples`])}-${Math.max(...r[`${key}OutputTokensSamples`])}]`
            : '';
        const armReport = arms
          .map(
            (a) =>
              `${a.label} ${r[`${a.key}OutputTokens`]}${spread(a.key)} (${r[`${a.key}ReductionPct`]}%)`
          )
          .join(' | ');
        console.log(`baseline ${r.baselineOutputTokens}${spread('baseline')} tok | ${armReport}`);
      } catch (err) {
        errors += 1;
        console.log(`ERROR: ${err.message}`);
      }
    }

    if (results.length === 0) {
      console.error(
        '\nEvery benchmark case failed — no results written. Fix the errors above and rerun.'
      );
      process.exitCode = 1;
      return;
    }

    console.log('\n--- Summary (honest, net-first — see docs/HONEST-NUMBERS.md) ---');
    const totalBaseline = results.reduce((s, r) => s + r.baselineOutputTokens, 0);
    console.log(`Baseline output total:      ${totalBaseline} tok`);
    for (const arm of arms) {
      const totalOut = results.reduce((s, r) => s + r[`${arm.key}OutputTokens`], 0);
      const saved = totalBaseline - totalOut;
      const overhead = results.reduce((s, r) => s + r[`${arm.key}InputTokensAdded`], 0);
      const net = saved - overhead;
      console.log(
        `${arm.label.padEnd(26)} output ${totalOut} tok ` +
          `(saved ${saved}, ${pct(totalBaseline, totalOut)}%), ` +
          `input +${overhead}, NET ${net >= 0 ? '+' : ''}${net}`
      );
    }

    const adversarial = results.filter((r) => r.tag === 'adversarial');
    const adversarialNet = adversarial.reduce((sum, r) => sum + r.netDelta, 0);
    console.log(
      `Adversarial net (distill-adaptive): ${adversarialNet}` +
        (adversarialNet < 0 ? '  (net-negative on adversarial cases — see docs/HONEST-NUMBERS.md)' : '')
    );

    for (const r of results) {
      r.mode = mode;
      r.repeats = repeats;
    }
    fs.writeFileSync(
      path.join(__dirname, 'last-run-results.json'),
      JSON.stringify(results, null, 2)
    );
    console.log('\nFull results written to benchmarks/last-run-results.json');
    if (errors > 0) {
      console.error(
        `\nWARNING: ${errors} case(s) errored and are missing from the results — ` +
          'totals above cover only the cases that completed.'
      );
      process.exitCode = 1;
    }
  } finally {
    if (neutralCwd) {
      fs.rmSync(neutralCwd, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

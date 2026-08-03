'use strict';

/**
 * Benchmark-derived output-reduction ratios by task bucket, used by the Stop
 * hook to estimate skill-side baseline tokens WITHOUT a live shadow API call.
 *
 * Buckets reuse the taxonomy from plugin/hooks/user-prompt-submit.js's
 * classify(): simple | moderate | complex.
 *
 * Sourced from benchmarks/last-run-results.json when a real `npm run
 * benchmark` run exists; otherwise falls back to the documented placeholder
 * defaults below. Every number derived from these ratios is logged with
 * `estimated: true` and reported separately from measured savings — see
 * docs/HONEST-NUMBERS.md.
 */

const fs = require('fs');
const path = require('path');

const RESULTS_PATH = path.join(__dirname, '..', '..', 'benchmarks', 'last-run-results.json');

// Placeholder defaults until a real benchmark run overwrites them: heavy
// reduction on simple/formulaic turns, near-none on complex reasoning.
const DEFAULT_RATIOS = { simple: 0.55, moderate: 0.3, complex: 0.05 };

// Which benchmark prompt ids feed which bucket's average (see
// benchmarks/prompts.json for the cases themselves).
const ID_TO_BUCKET = {
  'commit-message': 'simple',
  'status-update': 'simple',
  'single-fact-question': 'simple',
  'explain-bug-fix': 'moderate',
  'architecture-tradeoffs': 'complex',
  'math-proof': 'complex',
};

/**
 * @param {string} [resultsPath] - override for tests
 * @returns {{ simple: number, moderate: number, complex: number, source: 'benchmark'|'default' }}
 */
function loadRatios(resultsPath = RESULTS_PATH) {
  let results;
  try {
    results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  } catch {
    return { ...DEFAULT_RATIOS, source: 'default' };
  }
  if (!Array.isArray(results)) {
    return { ...DEFAULT_RATIOS, source: 'default' };
  }

  const sums = { simple: [], moderate: [], complex: [] };
  for (const r of results) {
    const bucket = ID_TO_BUCKET[r?.id];
    if (!bucket) continue;
    if (typeof r.baselineOutputTokens !== 'number' || typeof r.distilledOutputTokens !== 'number') continue;
    if (r.baselineOutputTokens <= 0) continue;
    const reduction = (r.baselineOutputTokens - r.distilledOutputTokens) / r.baselineOutputTokens;
    // Clamp: a net-inflating case shouldn't produce a negative ratio that
    // makes baseline estimates smaller than actuals.
    sums[bucket].push(Math.min(Math.max(reduction, 0), 0.95));
  }

  const ratios = { ...DEFAULT_RATIOS, source: 'benchmark' };
  let any = false;
  for (const bucket of Object.keys(sums)) {
    if (sums[bucket].length > 0) {
      ratios[bucket] = sums[bucket].reduce((a, b) => a + b, 0) / sums[bucket].length;
      any = true;
    }
  }
  if (!any) ratios.source = 'default';
  return ratios;
}

/**
 * @param {'simple'|'moderate'|'complex'} bucket
 * @param {string} [resultsPath]
 * @returns {number} reduction ratio in [0, 0.95]
 */
function ratioForBucket(bucket, resultsPath) {
  const ratios = loadRatios(resultsPath);
  return ratios[bucket] ?? ratios.moderate;
}

module.exports = { loadRatios, ratioForBucket, DEFAULT_RATIOS, ID_TO_BUCKET };

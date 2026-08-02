'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanForTriggers } = require('../lib/allowlist');
const {
  compressDescription,
  compressListResult,
  DescriptionCache,
  llmRewriteDescription,
} = require('../lib/compress-descriptions');
const {
  compressResultText,
  compressCallResult,
  stripAnsi,
  collapseRepeats,
  minifyJson,
} = require('../lib/compress-results');
const { handleServerLine } = require('../index');
const { loadRatios, ratioForBucket, DEFAULT_RATIOS } = require('../lib/baseline-ratios');
const { logEvent, summarize } = require('../lib/telemetry');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'distill-test-')), name);
}

// --- allowlist ---

test('allowlist catches destructive command language', () => {
  const { matched } = scanForTriggers('This will run rm -rf on the target directory.');
  assert.strictEqual(matched, true);
});

test('allowlist catches caveat language', () => {
  const { matched } = scanForTriggers('Only works if the file already exists.');
  assert.strictEqual(matched, true);
});

test('allowlist does not false-positive on plain description', () => {
  const { matched } = scanForTriggers('Fetches the current weather for a given city.');
  assert.strictEqual(matched, false);
});

test('allowlist catches destructive paraphrases', () => {
  const positives = [
    'This wipes everything on the target volume.',
    'Running this erases all data from the device.',
    'Warning: possible data loss if the sync is interrupted.',
    'The deletion is unrecoverable.',
    'Do a factory reset of the appliance.',
    'git reset --hard origin/main discards local commits.',
    'git clean removes untracked files.',
    'This purges the database completely.',
    'Proceeding without a backup is risky.',
    'There is no rollback for this migration.',
  ];
  for (const text of positives) {
    assert.strictEqual(scanForTriggers(text).matched, true, `should match: ${text}`);
  }
});

test('allowlist avoids paraphrase false positives', () => {
  const negatives = [
    'Wipe the screen with a soft cloth.',
    'The eraser tool removes strokes from the canvas.',
    'Reset the form fields to defaults.',
    'Purge stale entries from the in-memory cache periodically.',
  ];
  for (const text of negatives) {
    assert.strictEqual(scanForTriggers(text).matched, false, `should NOT match: ${text}`);
  }
});

test('allowlist handles non-string input without throwing', () => {
  assert.deepStrictEqual(scanForTriggers(null), { matched: false, patterns: [] });
  assert.deepStrictEqual(scanForTriggers(undefined), { matched: false, patterns: [] });
  assert.deepStrictEqual(scanForTriggers(42), { matched: false, patterns: [] });
});

// --- compressDescription ---

test('compressDescription strips boilerplate but keeps meaning', () => {
  const input =
    'This tool can be used to fetch weather data. Please note that it requires an API key.';
  const out = compressDescription(input);
  assert.ok(!/please note that/i.test(out));
  assert.ok(/API key/.test(out));
});

test('compressDescription substitutes connectives instead of deleting them', () => {
  const cache = new DescriptionCache(tmpFile('cache.json'));
  const out = compressDescription(
    'In order to locate the file, provide its absolute path. Supports JSON as well as YAML.',
    cache
  );
  assert.ok(/to locate the file/i.test(out), `"to locate" survives: ${out}`);
  assert.ok(!/in order to/i.test(out));
  assert.ok(/JSON and YAML/.test(out), `conjunction preserved: ${out}`);
});

test('compressDescription leaves destructive-action sentences untouched', () => {
  const input =
    'This tool can be used to delete records. Warning: this action is irreversible and cannot be undone.';
  const out = compressDescription(input);
  assert.ok(
    /Warning: this action is irreversible and cannot be undone\./.test(out),
    'protected sentence should survive verbatim'
  );
});

test('compressDescription handles empty/non-string input', () => {
  assert.strictEqual(compressDescription(''), '');
  assert.strictEqual(compressDescription(null), null);
  assert.strictEqual(compressDescription(undefined), undefined);
});

test('compressListResult compresses tool + param descriptions and reports stats', () => {
  const listResult = {
    tools: [
      {
        name: 'delete_file',
        description:
          'This tool can be used to delete a file. Please note that it requires a valid path.',
        inputSchema: {
          properties: {
            path: {
              description: 'In order to locate the file, provide its absolute path.',
            },
          },
        },
      },
    ],
  };
  const { result, stats } = compressListResult(listResult);
  assert.ok(stats.originalChars > stats.compressedChars);
  assert.ok(!/please note that/i.test(result.tools[0].description));
  assert.ok(!/in order to/i.test(result.tools[0].inputSchema.properties.path.description));
});

test('compressListResult tolerates malformed items', () => {
  const { stats } = compressListResult({
    tools: [{}, { description: 42 }, { description: 'Please note that x.', inputSchema: { properties: null } }],
  });
  assert.ok(stats.originalChars > 0);
});

// --- DescriptionCache persistence (Gap 6) ---

test('DescriptionCache persists across instances via its cache file', () => {
  const cachePath = tmpFile('cache.json');
  const a = new DescriptionCache(cachePath);
  a.set('long original description', 'short');
  const b = new DescriptionCache(cachePath);
  assert.strictEqual(b.get('long original description'), 'short');
});

test('DescriptionCache starts empty on corrupt cache file', () => {
  const cachePath = tmpFile('cache.json');
  fs.writeFileSync(cachePath, '{not json!!');
  const c = new DescriptionCache(cachePath);
  assert.strictEqual(c.get('anything'), undefined);
  c.set('x', 'y'); // and can still write through
  assert.strictEqual(new DescriptionCache(cachePath).get('x'), 'y');
});

test('DescriptionCache caps entries (FIFO)', () => {
  const cachePath = tmpFile('cache.json');
  const c = new DescriptionCache(cachePath);
  for (let i = 0; i < 510; i++) c.set(`desc-${i}`, `v-${i}`);
  assert.strictEqual(c.map.size, 500);
  assert.strictEqual(c.get('desc-0'), undefined, 'oldest evicted');
  assert.strictEqual(c.get('desc-509'), 'v-509', 'newest kept');
});

test('DescriptionCache survives unwritable cache path', () => {
  const c = new DescriptionCache('/nonexistent-root-dir-distill/cache.json');
  c.set('a', 'b'); // write-through fails silently
  assert.strictEqual(c.get('a'), 'b'); // in-memory still works
});

// --- handleServerLine (Gap 4: crash-safe bridge) ---

test('handleServerLine passes non-JSON lines through untouched', () => {
  const line = 'not json at all {{{';
  assert.strictEqual(handleServerLine(line, new Map()), line);
});

test('handleServerLine compresses a tracked list response', () => {
  const pending = new Map([[7, true]]);
  const line = JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    result: { tools: [{ name: 't', description: 'Please note that it works.' }] },
  });
  const out = handleServerLine(line, pending, { logFn: () => {} });
  assert.ok(!/please note that/i.test(out));
  assert.strictEqual(pending.size, 0, 'pending entry consumed');
});

test('handleServerLine forwards ORIGINAL line when compression throws', () => {
  const pending = new Map([[1, true]]);
  const line = JSON.stringify({ id: 1, result: { tools: [{ description: 'x' }] } });
  const out = handleServerLine(line, pending, {
    compressFn: () => {
      throw new Error('boom');
    },
    logFn: () => {},
  });
  assert.strictEqual(out, line);
});

test('handleServerLine survives a throwing telemetry logger', () => {
  const pending = new Map([[2, true]]);
  const line = JSON.stringify({
    id: 2,
    result: { tools: [{ description: 'Please note that it works fine today.' }] },
  });
  const out = handleServerLine(line, pending, {
    logFn: () => {
      throw new Error('disk full');
    },
  });
  assert.ok(!/please note that/i.test(out), 'compression still applied');
});

test('handleServerLine cleans pending map on error responses (no leak)', () => {
  const pending = new Map([[3, true]]);
  const line = JSON.stringify({ id: 3, error: { code: -32000, message: 'nope' } });
  const out = handleServerLine(line, pending, { logFn: () => {} });
  assert.strictEqual(out, line);
  assert.strictEqual(pending.size, 0);
});

test('handleServerLine leaves untracked responses untouched', () => {
  const line = JSON.stringify({ id: 99, result: { tools: [{ description: 'Please note that x.' }] } });
  assert.strictEqual(handleServerLine(line, new Map(), { logFn: () => {} }), line);
});

test('handleServerLine handles a 5MB line without modification when untracked', () => {
  const big = JSON.stringify({ id: 50, result: { data: 'x'.repeat(5 * 1024 * 1024) } });
  const out = handleServerLine(big, new Map(), { logFn: () => {} });
  assert.strictEqual(out, big);
});

test('handleServerLine tolerates JSON scalars and arrays (batches) as lines', () => {
  assert.strictEqual(handleServerLine('42', new Map()), '42');
  assert.strictEqual(handleServerLine('null', new Map()), 'null');
  const batch = JSON.stringify([{ id: 1 }, { id: 2 }]);
  assert.strictEqual(handleServerLine(batch, new Map([[1, true]])), batch);
});

// --- tool-result compression (P1) ---

test('stripAnsi removes escape codes but keeps bracketed text', () => {
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m [info] ok'), 'red [info] ok');
});

test('compressResultText collapses blank runs and trailing whitespace', () => {
  assert.strictEqual(compressResultText('a   \n\n\n\n\nb'), 'a\n\nb');
});

test('collapseRepeats marks repeated lines explicitly', () => {
  const out = collapseRepeats('x\nx\nx\nx\nx\ny');
  assert.ok(out.includes('repeated 4 more times'), out);
  assert.strictEqual(out.split('\n').length, 3);
});

test('collapseRepeats leaves short repeats alone', () => {
  assert.strictEqual(collapseRepeats('x\nx\ny'), 'x\nx\ny');
});

test('minifyJson compacts pretty JSON but not invalid or non-JSON', () => {
  const pretty = JSON.stringify({ a: 1, list: [1, 2, 3] }, null, 4);
  assert.strictEqual(minifyJson(pretty), JSON.stringify({ a: 1, list: [1, 2, 3] }));
  assert.strictEqual(minifyJson('not json {'), 'not json {');
});

test('compressResultText never touches allowlist-protected content', () => {
  const dangerous = 'Step 1: run rm -rf ./build\n\n\n\nStep 2: rebuild';
  assert.strictEqual(compressResultText(dangerous), dangerous);
});

test('compressCallResult compresses text blocks and reports stats', () => {
  const payload = {
    content: [
      { type: 'text', text: '\x1b[32mPASS\x1b[0m suite one\n\n\n\n\n\nok' },
      { type: 'image', data: 'xyz' },
    ],
  };
  const { stats } = compressCallResult(payload);
  assert.ok(stats.compressedChars < stats.originalChars);
  assert.ok(!payload.content[0].text.includes('\x1b'));
});

test('handleServerLine routes call-kind responses through result compression', () => {
  const pending = new Map([[9, 'call']]);
  const line = JSON.stringify({
    id: 9,
    result: { content: [{ type: 'text', text: 'line\n\n\n\n\nend' }] },
  });
  const out = handleServerLine(line, pending, { logFn: () => {} });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.result.content[0].text, 'line\n\nend');
  assert.strictEqual(pending.size, 0);
});

// --- cross-tool dedup (P1) ---

test('compressListResult dedups identical long descriptions with a reference', () => {
  const long = 'Provide the absolute filesystem path to the target file. '.repeat(4);
  const listResult = {
    tools: [
      { name: 'read_file', description: long },
      { name: 'write_file', description: long },
      { name: 'stat_file', description: long },
    ],
  };
  const { result } = compressListResult(listResult);
  assert.notStrictEqual(result.tools[0].description, 'Same as `read_file`.');
  assert.strictEqual(result.tools[1].description, 'Same as `read_file`.');
  assert.strictEqual(result.tools[2].description, 'Same as `read_file`.');
});

test('compressListResult does not dedup short descriptions', () => {
  const short = 'A path.';
  const { result } = compressListResult({
    tools: [
      { name: 'a', description: short },
      { name: 'b', description: short },
    ],
  });
  assert.strictEqual(result.tools[1].description, short);
});

// --- LLM rewrite verification (P1) ---

test('llmRewriteDescription accepts a shorter rewrite that keeps triggers', () => {
  const original =
    'This tool deletes records in bulk from the datastore backend service. ' +
    'Warning: this operation is irreversible once committed to the store. ' +
    'It also supports filtering by date range and by record type prefixes.';
  const out = llmRewriteDescription(original, () => 'Bulk-deletes records; irreversible. Supports date/type filters.');
  assert.ok(out && out.length < original.length);
});

test('llmRewriteDescription rejects a rewrite that drops a trigger', () => {
  const original =
    'This tool deletes records in bulk from the datastore backend service. ' +
    'Warning: this operation is irreversible once committed to the store. ' +
    'It also supports filtering by date range and by record type prefixes.';
  assert.strictEqual(
    llmRewriteDescription(original, () => 'Bulk-deletes records. Supports date/type filters.'),
    null
  );
});

test('llmRewriteDescription rejects longer or empty rewrites and runner errors', () => {
  const original = 'Short description of a tool that fetches weather.';
  assert.strictEqual(llmRewriteDescription(original, () => original + ' padded longer'), null);
  assert.strictEqual(llmRewriteDescription(original, () => ''), null);
  assert.strictEqual(
    llmRewriteDescription(original, () => {
      throw new Error('cli missing');
    }),
    null
  );
});

test('compressDescription uses injected LLM runner and caches the rewrite', () => {
  const cache = new DescriptionCache(tmpFile('cache.json'));
  const original =
    'This tool can be used to fetch weather data from the remote provider API. '.repeat(6);
  let calls = 0;
  const runner = () => {
    calls += 1;
    return 'Fetches weather data from the remote provider API.';
  };
  const first = compressDescription(original, cache, runner);
  const second = compressDescription(original, cache, runner);
  assert.strictEqual(first, 'Fetches weather data from the remote provider API.');
  assert.strictEqual(second, first);
  assert.strictEqual(calls, 1, 'rewrite paid exactly once');
});

// --- baseline-ratios (Gap 2) ---

test('baseline-ratios falls back to defaults when no benchmark file exists', () => {
  const r = loadRatios(tmpFile('missing.json'));
  assert.strictEqual(r.source, 'default');
  assert.deepStrictEqual(
    { simple: r.simple, moderate: r.moderate, complex: r.complex },
    DEFAULT_RATIOS
  );
});

test('baseline-ratios averages real benchmark results per bucket', () => {
  const p = tmpFile('results.json');
  fs.writeFileSync(
    p,
    JSON.stringify([
      { id: 'commit-message', baselineOutputTokens: 100, distilledOutputTokens: 40 },
      { id: 'status-update', baselineOutputTokens: 100, distilledOutputTokens: 60 },
      { id: 'math-proof', baselineOutputTokens: 200, distilledOutputTokens: 190 },
      { id: 'unknown-id', baselineOutputTokens: 100, distilledOutputTokens: 0 },
    ])
  );
  const r = loadRatios(p);
  assert.strictEqual(r.source, 'benchmark');
  assert.ok(Math.abs(r.simple - 0.5) < 1e-9, `simple avg of 0.6/0.4: ${r.simple}`);
  assert.ok(Math.abs(r.complex - 0.05) < 1e-9);
  assert.strictEqual(r.moderate, DEFAULT_RATIOS.moderate, 'unseen bucket keeps default');
});

test('baseline-ratios clamps net-inflating cases to zero', () => {
  const p = tmpFile('results.json');
  fs.writeFileSync(
    p,
    JSON.stringify([{ id: 'single-fact-question', baselineOutputTokens: 10, distilledOutputTokens: 15 }])
  );
  assert.strictEqual(loadRatios(p).simple, 0);
});

test('baseline-ratios tolerates corrupt results file', () => {
  const p = tmpFile('results.json');
  fs.writeFileSync(p, 'garbage');
  assert.strictEqual(loadRatios(p).source, 'default');
  assert.strictEqual(typeof ratioForBucket('moderate', p), 'number');
});

// --- telemetry (measured/estimated split) ---

test('telemetry splits measured vs estimated and keeps flat totals', () => {
  const logPath = tmpFile('telemetry.log');
  logEvent({ source: 'middleware_tool_list', outputTokensBaseline: 100, outputTokensActual: 60, inputTokensAdded: 0 }, logPath);
  logEvent({ source: 'skill_output', outputTokensBaseline: 200, outputTokensActual: 100, inputTokensAdded: 50, estimated: true }, logPath);
  logEvent({ source: 'stop_hook_allowlist_check', allowlistReexpansionTriggered: true, reexpansionCostTokens: 25, estimated: true }, logPath);

  const s = summarize(logPath);
  assert.strictEqual(s.events, 3);
  assert.strictEqual(s.measured.outputTokensSaved, 40);
  assert.strictEqual(s.measured.netDelta, 40);
  assert.strictEqual(s.estimated.outputTokensSaved, 100);
  assert.strictEqual(s.estimated.inputTokensAdded, 50);
  assert.strictEqual(s.estimated.netDelta, 50);
  assert.strictEqual(s.outputTokensSaved, 140);
  assert.strictEqual(s.netDelta, 90);
  assert.strictEqual(s.allowlistReexpansions, 1);
  assert.strictEqual(s.reexpansionCostTokens, 25);
});

test('telemetry summarize skips malformed lines and missing files', () => {
  const logPath = tmpFile('telemetry.log');
  fs.writeFileSync(logPath, 'not json\n' + JSON.stringify({ inputTokensAdded: 5 }) + '\n');
  const s = summarize(logPath);
  assert.strictEqual(s.events, 1, 'only parseable lines counted');
  assert.strictEqual(s.inputTokensAdded, 5);
  assert.strictEqual(summarize(tmpFile('missing.log')).events, 0);
});

test('telemetry logEvent never throws on unwritable path', () => {
  logEvent({ source: 'skill_output' }, '/nonexistent-root-dir-distill/t.log');
});

test('telemetry rotates the log at the size cap', () => {
  const logPath = tmpFile('telemetry.log');
  const tinyCap = 300;
  for (let i = 0; i < 20; i++) {
    logEvent({ source: 'middleware_tool_list', outputTokensBaseline: 10, outputTokensActual: 5 }, logPath, tinyCap);
  }
  assert.ok(fs.existsSync(logPath + '.1'), 'rotated generation exists');
  assert.ok(fs.statSync(logPath).size < tinyCap + 200, 'current log stays near the cap');
  const s = summarize(logPath);
  assert.ok(s.events > 0 && s.events < 20, 'summarize reads only the current generation');
});

console.log(`\n${passed} test(s) passed`);

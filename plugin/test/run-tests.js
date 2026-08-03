'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classify, isClarification, stepDown, applySimpleStreak } = require('../hooks/user-prompt-submit');
const { extractTurnContext, findProtectedMisses } = require('../hooks/stop');
const { shouldNudge } = require('../hooks/post-tool-use');

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

// --- vendored lib files (Gap: marketplace installs ship only plugin/, so
// hooks/scripts can't reach middleware/lib/ — plugin/lib/ holds byte-identical
// copies; this test catches drift between the two before it ships broken) ---

test('plugin/lib vendored copies stay in sync with middleware/lib', () => {
  const vendored = path.join(__dirname, '..', 'lib');
  const source = path.join(__dirname, '..', '..', 'middleware', 'lib');
  for (const file of ['telemetry.js', 'allowlist.js', 'baseline-ratios.js']) {
    const a = fs.readFileSync(path.join(vendored, file), 'utf8');
    const b = fs.readFileSync(path.join(source, file), 'utf8');
    assert.strictEqual(a, b, `plugin/lib/${file} has drifted from middleware/lib/${file} — copy the source over`);
  }
});

// --- classify (shared with Stop hook's bucket estimate) ---

test('classify buckets simple/complex/moderate prompts', () => {
  assert.strictEqual(classify('write a commit message for this'), 'simple');
  assert.strictEqual(classify('ok'), 'simple');
  assert.strictEqual(classify('debug why the cache misses'), 'complex');
  assert.strictEqual(classify('walk me through the architecture tradeoffs'), 'complex');
  assert.strictEqual(classify('rename this variable everywhere'), 'moderate');
});

test('classify treats code fences and long pastes as complex', () => {
  assert.strictEqual(classify('why does this fail?\n```js\nconst x = 1;\n```'), 'complex');
  assert.strictEqual(classify('x'.repeat(700)), 'complex');
  assert.strictEqual(
    classify('here is the error: TypeError blah '.padEnd(250, 'x') + ' stack trace follows'),
    'complex'
  );
  assert.strictEqual(classify('short error mention'), 'moderate');
});

test('applySimpleStreak nudges moderate to simple after a streak, never complex', () => {
  assert.strictEqual(applySimpleStreak('moderate', 3), 'simple');
  assert.strictEqual(applySimpleStreak('moderate', 2), 'moderate');
  assert.strictEqual(applySimpleStreak('complex', 5), 'complex');
  assert.strictEqual(applySimpleStreak('simple', 5), 'simple');
});

// --- clarification back-off (Gap 3) ---

test('isClarification detects follow-up confusion', () => {
  assert.strictEqual(isClarification('what did you mean by that?'), true);
  assert.strictEqual(isClarification("i don't understand"), true);
  assert.strictEqual(isClarification('what?'), true);
  assert.strictEqual(isClarification('huh'), true);
  assert.strictEqual(isClarification('add a logout button'), false);
  assert.strictEqual(isClarification('what port does the server use'), false);
});

test('stepDown lowers compression one level and floors at complex', () => {
  assert.strictEqual(stepDown('simple'), 'moderate');
  assert.strictEqual(stepDown('moderate'), 'complex');
  assert.strictEqual(stepDown('complex'), 'complex');
});

// --- Stop hook: transcript walk (Gap 1) ---

function line(obj) {
  return JSON.stringify(obj);
}

test('extractTurnContext finds nearest real user message and tool results', () => {
  const lines = [
    line({ type: 'user', message: { content: 'old turn: DROP TABLE users' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'user', message: { content: 'drop the legacy table for me' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'checking' }], usage: { output_tokens: 42 } } }),
    line({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'WARNING: operation is irreversible' }] }],
      },
    }),
  ];
  const ctx = extractTurnContext(lines);
  assert.strictEqual(ctx.userText, 'drop the legacy table for me');
  assert.ok(/irreversible/.test(ctx.toolResultText));
  assert.ok(!/DROP TABLE users/.test(ctx.userText), 'older turn excluded');
  assert.strictEqual(ctx.lastAssistantUsage.output_tokens, 42);
});

test('extractTurnContext tolerates malformed lines and empty input', () => {
  const ctx = extractTurnContext(['garbage', '{"half": ', line({ type: 'other' })]);
  assert.strictEqual(ctx.userText, '');
  assert.deepStrictEqual(extractTurnContext([]).toolResultText, '');
});

// --- Stop hook: miss detection (Gap 1) ---

test('findProtectedMisses flags a dropped protected trigger', () => {
  const context = 'The migration drops users_legacy. This action is irreversible.';
  const final = 'Migration done.';
  const misses = findProtectedMisses(context, final);
  assert.strictEqual(misses.length, 1);
  assert.strictEqual(misses[0].trigger.toLowerCase(), 'irreversible');
});

test('findProtectedMisses passes when the trigger text survives', () => {
  const context = 'This action is irreversible and cannot be undone.';
  const final = 'Careful: the drop is irreversible — it cannot be undone. Proceed?';
  assert.strictEqual(findProtectedMisses(context, final).length, 0);
});

test('findProtectedMisses is case-insensitive on the presence check', () => {
  const context = 'Never run rm -rf here.';
  const final = 'Do not use RM -RF on this host.';
  assert.strictEqual(findProtectedMisses(context, final).length, 0);
});

test('findProtectedMisses returns empty for clean context or empty input', () => {
  assert.deepStrictEqual(findProtectedMisses('fetch the weather', 'sunny'), []);
  assert.deepStrictEqual(findProtectedMisses('', 'anything'), []);
  assert.deepStrictEqual(findProtectedMisses(null, 'anything'), []);
});

test('findProtectedMisses dedupes repeated triggers', () => {
  const context = 'This is irreversible. Really irreversible. Irreversible, truly.';
  const misses = findProtectedMisses(context, 'ok');
  assert.strictEqual(misses.length, 1);
});

// --- PostToolUse nudge (Gap 5) ---

const enabledState = {
  autoCompactMemoryFiles: true,
  memoryFileGlobs: ['CLAUDE.md'],
};

test('shouldNudge requires the opt-in flag', () => {
  assert.strictEqual(
    shouldNudge('/p/CLAUDE.md', { autoCompactMemoryFiles: false }, { sizeOf: () => 9999 }),
    false
  );
});

test('shouldNudge fires only for watched basenames', () => {
  assert.strictEqual(shouldNudge('/p/CLAUDE.md', enabledState, { sizeOf: () => 9999 }), true);
  assert.strictEqual(shouldNudge('/p/sub/claude.md', enabledState, { sizeOf: () => 9999 }), true);
  assert.strictEqual(shouldNudge('/p/README.md', enabledState, { sizeOf: () => 9999 }), false);
  assert.strictEqual(shouldNudge('', enabledState, { sizeOf: () => 9999 }), false);
});

test('shouldNudge respects the size threshold', () => {
  assert.strictEqual(shouldNudge('/p/CLAUDE.md', enabledState, { sizeOf: () => 100 }), false);
});

test('shouldNudge respects the cooldown', () => {
  const now = Date.now();
  const state = { ...enabledState, lastAutoCompactNudgeAt: new Date(now - 60 * 1000).toISOString() };
  assert.strictEqual(shouldNudge('/p/CLAUDE.md', state, { sizeOf: () => 9999, now }), false);
  const cooled = { ...enabledState, lastAutoCompactNudgeAt: new Date(now - 11 * 60 * 1000).toISOString() };
  assert.strictEqual(shouldNudge('/p/CLAUDE.md', cooled, { sizeOf: () => 9999, now }), true);
});

console.log(`\n${passed} test(s) passed`);

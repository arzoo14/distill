'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DISTILL_HOME = path.join(os.homedir(), '.distill');
const LOG_PATH = path.join(DISTILL_HOME, 'telemetry.log');

function ensureDir(logPath) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append one telemetry event. Always logs net-relevant fields together so
 * reporting never accidentally becomes output-only (see docs/HONEST-NUMBERS.md).
 *
 * Never throws: telemetry is an observer, and a failed write (read-only home,
 * full disk) must not break the middleware bridge or a plugin hook.
 *
 * @param {object} event
 * @param {"skill_output"|"middleware_tool_list"|"stop_hook_allowlist_check"} event.source
 * @param {number} [event.outputTokensBaseline]
 * @param {number} [event.outputTokensActual]
 * @param {number} [event.inputTokensAdded]
 * @param {boolean} [event.estimated] - true when token counts are ratio-derived
 *   estimates (skill side) rather than measured character/token counts
 * @param {boolean} [event.allowlistReexpansionTriggered]
 * @param {number} [event.reexpansionCostTokens]
 * @param {string} [logPath] - override for tests
 */
function logEvent(event, logPath = LOG_PATH) {
  try {
    ensureDir(logPath);
    const record = {
      ts: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch {
    // Best-effort only.
  }
}

function emptyBucket() {
  return { events: 0, outputTokensSaved: 0, inputTokensAdded: 0, netDelta: 0 };
}

/**
 * Read back all events and compute the single honest net-savings number.
 *
 * The top-level flat fields are measured + estimated combined (stable shape
 * for existing consumers). `measured` covers middleware events with real
 * char/token counts; `estimated` covers skill-side events derived from
 * benchmark ratios — reported separately so the two are never silently
 * blended into one credibility claim (docs/HONEST-NUMBERS.md).
 *
 * @param {string} [logPath] - override for tests
 */
function summarize(logPath = LOG_PATH) {
  const empty = {
    events: 0,
    measured: emptyBucket(),
    estimated: emptyBucket(),
    outputTokensSaved: 0,
    inputTokensAdded: 0,
    netDelta: 0,
    allowlistReexpansions: 0,
    reexpansionCostTokens: 0,
  };

  let lines;
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return empty;
  }

  const summary = empty;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    summary.events += 1;

    const bucket = event.estimated ? summary.estimated : summary.measured;
    bucket.events += 1;
    if (
      typeof event.outputTokensBaseline === 'number' &&
      typeof event.outputTokensActual === 'number'
    ) {
      bucket.outputTokensSaved += event.outputTokensBaseline - event.outputTokensActual;
    }
    if (typeof event.inputTokensAdded === 'number') {
      bucket.inputTokensAdded += event.inputTokensAdded;
    }
    if (event.allowlistReexpansionTriggered) {
      summary.allowlistReexpansions += 1;
    }
    if (typeof event.reexpansionCostTokens === 'number') {
      summary.reexpansionCostTokens += event.reexpansionCostTokens;
    }
  }

  for (const bucket of [summary.measured, summary.estimated]) {
    bucket.netDelta = bucket.outputTokensSaved - bucket.inputTokensAdded;
  }
  summary.outputTokensSaved = summary.measured.outputTokensSaved + summary.estimated.outputTokensSaved;
  summary.inputTokensAdded = summary.measured.inputTokensAdded + summary.estimated.inputTokensAdded;
  summary.netDelta = summary.outputTokensSaved - summary.inputTokensAdded;

  return summary;
}

module.exports = { logEvent, summarize, LOG_PATH };

#!/usr/bin/env node
'use strict';

/**
 * distill-shrink — MCP middleware entrypoint.
 *
 * Usage:
 *   distill-shrink -- <command> [args...]
 *
 * Example (wrapping a stdio MCP server):
 *   distill-shrink -- npx -y @some/mcp-server --flag
 *
 * Spawns the wrapped MCP server as a child process, passes stdio through
 * transparently, and intercepts `tools/list` (and `resources/list`) JSON-RPC
 * responses to compress verbose descriptions before they reach the agent.
 * Every other message is passed through byte-for-byte unmodified.
 *
 * Failure policy (design-spec Principle A): a compaction or telemetry failure
 * must never block a tool call — on any error the original line is forwarded
 * unmodified.
 *
 * This is Phase 1 of the Distill toolkit: input-side savings with zero change
 * to model behavior.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const { compressListResult } = require('./lib/compress-descriptions');
const { compressCallResult } = require('./lib/compress-results');
const { logEvent } = require('./lib/telemetry');

const RESULTS_ENABLED = process.env.DISTILL_SHRINK_RESULTS !== 'off';

function parseArgs(argv) {
  const sepIndex = argv.indexOf('--');
  if (sepIndex === -1 || sepIndex === argv.length - 1) {
    console.error('Usage: distill-shrink -- <command> [args...]');
    process.exit(1);
  }
  const [cmd, ...cmdArgs] = argv.slice(sepIndex + 1);
  return { cmd, cmdArgs };
}

/**
 * Handle one line from the wrapped server and return the line to forward to
 * the agent. Extracted from main() so the passthrough-on-failure behavior is
 * unit-testable without spawning a child process.
 *
 * `pendingCalls` maps request id -> kind ('list' for tools/resources
 * listings, 'call' for tool invocations).
 *
 * On any compression error the ORIGINAL line string is returned — not a
 * re-serialization of the parsed message, because both compressors mutate
 * payloads in place and the parsed object may be half-modified by the time
 * an exception surfaces.
 *
 * @param {string} line
 * @param {Map<string|number, 'list'|'call'>} pendingCalls
 * @param {{ compressFn?: typeof compressListResult, compressResultFn?: typeof compressCallResult, logFn?: typeof logEvent }} [deps]
 * @returns {string} the line to write to stdout
 */
function handleServerLine(
  line,
  pendingCalls,
  { compressFn = compressListResult, compressResultFn = compressCallResult, logFn = logEvent } = {}
) {
  if (!line.trim()) return line;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Not JSON-RPC (e.g. partial/non-protocol output) — pass through.
    return line;
  }

  if (msg === null || typeof msg !== 'object' || msg.id === undefined || !pendingCalls.has(msg.id)) {
    return line;
  }

  // This response answers a tracked request — stop tracking it whether or
  // not it carries a result (error responses have no result and must not
  // leak map entries).
  const kind = pendingCalls.get(msg.id);
  pendingCalls.delete(msg.id);
  if (!msg.result) return line;

  try {
    const { stats } =
      kind === 'call' ? compressResultFn(msg.result) : compressFn(msg.result);

    if (stats.originalChars > 0 && stats.originalChars !== stats.compressedChars) {
      try {
        logFn({
          source: kind === 'call' ? 'middleware_tool_result' : 'middleware_tool_list',
          // Rough chars->tokens estimate (÷4) kept explicit and separate from
          // the API-measured numbers used elsewhere — see HONEST-NUMBERS.md.
          outputTokensBaseline: Math.round(stats.originalChars / 4),
          outputTokensActual: Math.round(stats.compressedChars / 4),
          inputTokensAdded: 0,
        });
      } catch {
        // Telemetry failure must not block the response.
      }
    }

    return JSON.stringify(msg);
  } catch {
    // Compression failed — forward the original, uncompressed response.
    return line;
  }
}

function main() {
  const { cmd, cmdArgs } = parseArgs(process.argv.slice(2));

  const child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Track in-flight requests so we know which responses were listings or
  // tool invocations (JSON-RPC responses don't repeat the method name).
  const pendingCalls = new Map();

  // --- agent -> wrapped server: pass through untouched, but remember calls ---
  const agentToServer = readline.createInterface({ input: process.stdin });
  agentToServer.on('line', (line) => {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'tools/list' || msg.method === 'resources/list') {
          pendingCalls.set(msg.id, 'list');
        } else if (msg.method === 'tools/call' && RESULTS_ENABLED) {
          pendingCalls.set(msg.id, 'call');
        }
      } catch {
        // Not JSON, or malformed — pass through as-is without inspection.
      }
    }
    if (child.stdin.writable) {
      child.stdin.write(line + '\n');
    }
  });

  // --- wrapped server -> agent: intercept tracked responses, compress, forward ---
  const serverToAgent = readline.createInterface({ input: child.stdout });
  serverToAgent.on('line', (line) => {
    process.stdout.write(handleServerLine(line, pendingCalls) + '\n');
  });

  child.on('error', (err) => {
    console.error(`distill-shrink: failed to start "${cmd}": ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

module.exports = { handleServerLine, parseArgs };

if (require.main === module) {
  main();
}

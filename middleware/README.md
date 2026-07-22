# distill-shrink

MCP middleware that compresses verbose tool/resource descriptions before they
reach your agent's context. Part of [Distill](https://github.com/arzoo14/distill).

Wraps any stdio MCP server as a transparent proxy:

- **Tool/resource descriptions** (`tools/list`, `resources/list`): semantically
  compressed (boilerplate removed, meaning preserved), and identical long
  descriptions repeated across tools are deduplicated into an explicit
  `` Same as `other_tool`. `` reference.
- **Tool results** (`tools/call`): meaning-safe cleanup only — ANSI escape
  codes stripped, trailing whitespace and blank-line runs collapsed, runs of
  identical lines collapsed with a visible `(repeated N times)` marker,
  pretty-printed JSON minified. Repetitive logs shrink up to ~87%; disable
  with `DISTILL_SHRINK_RESULTS=off`.
- Everything else passes through byte-for-byte.

Sentences containing safety/destructive-action/caveat language are never
touched in either path — see the
[allowlist](https://github.com/arzoo14/distill/blob/main/docs/ALLOWLIST.md).

**Optional LLM rewrite** (`DISTILL_SHRINK_LLM=cli`): descriptions over 300
chars are rewritten once by a model via your local `claude` CLI (Haiku), then
cached permanently by content hash. Rewrites that drop any safety trigger are
discarded automatically, and the rewrite call's own token cost is logged as
input overhead — never hidden.

## Install

```bash
npm install -g distill-shrink
```

## Usage

Wrap the server command in your MCP client config:

```jsonc
// before
{ "command": "npx", "args": ["-y", "@some/mcp-server"] }

// after
{ "command": "distill-shrink", "args": ["--", "npx", "-y", "@some/mcp-server"] }
```

## Behavior

- **Fail-open**: any compression or telemetry error forwards the original
  message unmodified — a compaction failure never blocks a tool call.
- **Cached**: compressed descriptions persist in
  `~/.distill/description-cache.json` (keyed by content hash), so a server's
  descriptions are compressed once, not every session.
- **Honest telemetry**: token savings are logged to `~/.distill/telemetry.log`
  as measured character counts, reported as net delta — see
  [HONEST-NUMBERS](https://github.com/arzoo14/distill/blob/main/docs/HONEST-NUMBERS.md).

Requires Node 18+.

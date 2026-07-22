# distill-shrink

MCP middleware that compresses verbose tool/resource descriptions before they
reach your agent's context. Part of [Distill](https://github.com/arzoo14/distill).

Wraps any stdio MCP server as a transparent proxy: `tools/list` and
`resources/list` responses get their descriptions semantically compressed
(boilerplate removed, meaning preserved); every other message passes through
byte-for-byte. Sentences containing safety/destructive-action/caveat language
are never touched — see the [allowlist](https://github.com/arzoo14/distill/blob/main/docs/ALLOWLIST.md).

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

# Distill

**Cut the filler. Keep the meaning. Know the real number.**

Distill is a cross-platform token-efficiency toolkit for AI coding agents (Claude Code,
Cursor, Windsurf, Cline, Copilot, Gemini CLI, Codex, and any MCP-compatible agent).

Compressing agent chatter saves real money, but most compression approaches share the
same failure modes: they only compress output, report inflated output-only headline
numbers, can drop safety-relevant content at high compression, use a static compression
level all session, and carry meaningful overhead of their own. Distill addresses each
of those directly — see `docs/HONEST-NUMBERS.md` and `docs/ALLOWLIST.md`.

## Two things, one install

1. **The Skill** (`SKILL.md`) — changes how the agent *writes*. Semantic compression,
   not telegraphic grunt-speak. Adaptive per-turn intensity instead of a fixed dial.
2. **The Middleware** (`middleware/`, npm package `distill-shrink`) — changes what gets
   *loaded into context* in the first place: compresses verbose MCP tool/resource
   descriptions before they ever reach the model.

Both write to one shared telemetry log so "savings" is always a single, honest,
whole-session number — not two separate marketing claims.

## Quick install (all agents, auto-detect)

```bash
curl -fsSL https://raw.githubusercontent.com/arzoo14/distill/main/install.sh | bash
```

## Per-agent

| Agent | Install |
|---|---|
| Claude Code | `claude plugin marketplace add arzoo14/distill && claude plugin install distill@distill` |
| Codex CLI | `npx skills add arzoo14/distill -a codex` |
| Gemini CLI | `gemini extensions install distill` |
| Cursor / Windsurf / Cline | `npx skills add arzoo14/distill -a cursor --with-init` |
| Any MCP agent (middleware only) | `npm install -g distill-shrink` |

## Commands

- `/distill` — default adaptive mode (recommended default, on by default after install)
- `/distill light` / `/distill deep` — manual override of the adaptive target
- `/distill off` — disable for this session
- `/distill autocompact on|off` — opt into automatic memory-file compaction nudges
  when CLAUDE.md changes (off by default)
- `/distill-stats` — show net session token savings: measured middleware savings and
  estimated skill savings, reported separately, never blended
- `/distill-compact` — compact CLAUDE.md / project memory files on demand

See `docs/HONEST-NUMBERS.md` for what the numbers actually mean and where this tool can
go net-negative, and `docs/ALLOWLIST.md` for what content is never compressed.

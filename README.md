<p align="center">
  <img src="assets/logo.svg" alt="Distill" width="640"/>
</p>

<h3 align="center">Every token earns its place.</h3>

<p align="center">
  <em>Cut the filler. Keep the meaning. Know the real number.</em>
</p>

<p align="center">
  <a href="https://github.com/arzoo14/distill/actions/workflows/test.yml"><img src="https://github.com/arzoo14/distill/actions/workflows/test.yml/badge.svg" alt="CI"/></a>
  <a href="https://www.npmjs.com/package/distill-shrink"><img src="https://img.shields.io/npm/v/distill-shrink?label=distill-shrink" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license"/></a>
  <img src="https://img.shields.io/badge/status-beta-orange.svg" alt="beta"/>
</p>

> **Beta.** The architecture is tested (65 unit tests, a soak test with 3.95M
> real MCP operations, CI on Node 18/20/22) and the benchmark numbers below are
> real — but this is a first release with limited field usage. APIs, defaults,
> and telemetry formats may still shift before 1.0. Feedback and issues
> genuinely welcome: that's what a beta is for.

Distill is a token-efficiency toolkit for AI coding agents that attacks **both
sides** of your token bill — what the model writes *and* what gets loaded into
its context — with one rule no other compression tool enforces:
**safety-relevant content is never, ever compressed.** Not by prompt etiquette.
By code.

Works with Claude Code, Cursor, Windsurf, Cline, Codex, Copilot, Gemini CLI,
and any MCP-compatible agent.

```
                        ┌─────────────────────────────┐
   MCP servers ────────▶│  distill-shrink middleware  │────▶ smaller context
   (tools, results)     │  compress · dedup · cache   │      (input tokens ↓)
                        └─────────────────────────────┘
                        ┌─────────────────────────────┐
   agent responses ────▶│  Distill skill + Stop hook  │────▶ tighter output
   (what model writes)  │  adaptive · allowlisted     │      (output tokens ↓)
                        └─────────────────────────────┘
                                      │
                              one shared telemetry log
                              one honest net number
```

---

## Why Distill is different

Most compression tools are a writing style: a system prompt that says "be
terse." That approach has three problems Distill was built to fix:

| Problem with style-only compression | What Distill does instead |
|---|---|
| Only touches **output** — ignores tool descriptions and tool results, which usually dominate context | **MCP middleware** compresses input before the model ever sees it — measured up to **87% on repetitive tool logs** |
| At high compression, safety warnings get eaten along with the filler | A **structural allowlist**: 26+ trigger patterns (`rm -rf`, `DROP TABLE`, `irreversible`, `data loss`, …) enforced by a post-generation hook that **blocks the response** if a warning went missing |
| One static dial for the whole session, whether you're writing a commit message or debugging a race condition | **Adaptive per-turn compression** — a local (non-LLM) classifier reads each turn's shape and backs off automatically when you had to ask "what did you mean?" |

And one meta-difference: **we publish the numbers where Distill loses.** The
benchmark suite ships adversarial cases, reports medians with spread, and
`/distill-stats` will honestly tell you to turn output compression off if your
workload isn't benefiting. Read [docs/HONEST-NUMBERS.md](docs/HONEST-NUMBERS.md) —
it's the anti-hype spec this project is built on.

---

## The middleware: `distill-shrink`

A transparent proxy for any stdio MCP server. Wrap once, save every session:

```jsonc
// before
{ "command": "npx", "args": ["-y", "@some/mcp-server"] }

// after
{ "command": "npx", "args": ["-y", "distill-shrink", "--", "npx", "-y", "@some/mcp-server"] }
```

- **Tool & resource descriptions** — boilerplate stripped with meaning-safe
  substitutions, identical long descriptions across tools deduped into
  `` Same as `other_tool`. `` references
- **Tool results** — ANSI escape codes stripped, whitespace collapsed, repeated
  log lines folded with a visible `(repeated N times)` marker, pretty-printed
  JSON minified. Meaning-safe transforms only
- **Persistent cache** — each description is compressed once per server
  version, ever (`~/.distill/description-cache.json`)
- **Optional LLM rewrite** (`DISTILL_SHRINK_LLM=cli`) — one-time model rewrite
  of verbose descriptions, cached forever, auto-rejected if it drops a safety
  trigger, its own cost logged honestly as overhead
- **Fail-open by design** — any compression error forwards the original bytes.
  A compaction failure never blocks a tool call

**Soak-tested**: 3.95 million operations over 10 minutes against the real
`@modelcontextprotocol/server-filesystem` — zero errors, zero integrity
failures, flat memory, p99 latency 1 ms. Every allowlist-protected file came
back byte-identical, millions of times.

## The skill: adaptive semantic compression

Changes how the agent writes — **semantic** compression (remove redundancy and
scaffolding, never information), not telegraphic grunt-speak:

- **Adaptive by default**: commit messages and status updates get compressed
  hard; multi-step debugging and architecture discussions get answered
  naturally — and a compressed answer that forced you to ask a follow-up makes
  the next turns automatically less compressed
- **Deep mode** (`/distill deep`): maximum telegraphic density for quick-fire
  work — measured **+73% output reduction on status updates** — with the
  allowlist still enforced at full strength
- **Structural safety net**: a Stop hook re-scans each turn's context for
  destructive/safety triggers and blocks the response until a dropped warning
  is restored — the model's discipline is verified, not trusted
- **Memory-file compaction**: opt-in hook that nudges CLAUDE.md compression
  when it grows, debounced, allowlist-respecting

## Honest telemetry

```
$ /distill-stats

MEASURED (middleware — real character counts):     ← real bytes, real savings
ESTIMATED (skill — benchmark-derived ratio):       ← clearly labeled estimates
COMBINED net token delta / net cost in USD
NOTE: net ≤ 0 across N events — consider /distill off
```

Measured and estimated numbers are **never blended**. Net delta — output saved
*minus* everything the tool itself costs — is the only headline stat. If that
number is negative for your workload, Distill says so and tells you to turn it
off. Logs rotate at 10 MB. No external calls, ever.

---

## Install

**Everything, auto-detected:**

```bash
curl -fsSL https://raw.githubusercontent.com/arzoo14/distill/main/install.sh | bash
```

**Per agent** (every row below is a tested install path):

| Agent | Install |
|---|---|
| Claude Code | `claude plugin marketplace add arzoo14/distill && claude plugin install distill@distill` |
| Cursor / Windsurf / Cline | `npx skills add arzoo14/distill -a cursor` (or `windsurf` / `cline`) |
| Codex CLI | `npx skills add arzoo14/distill -a codex` |
| Any MCP agent (middleware only) | `npm install -g distill-shrink` |
| Copilot | copy `plugin/skills/distill/SKILL.md` into your Copilot instructions |

## Commands

- `/distill` — show current mode (adaptive is the default)
- `/distill light` / `/distill deep` / `/distill off` — manual override, persists across sessions
- `/distill autocompact on|off` — opt into memory-file compaction nudges
- `/distill-stats` — net session savings, measured vs estimated, in tokens and USD
- `/distill-compact [file]` — compact CLAUDE.md / project notes on demand

---

## The numbers, without the marketing

From the published benchmark run (`--repeats 3` medians, claude-sonnet-5):

- Adaptive mode: **+0.3%** output vs baseline — *neutral* inside Claude Code,
  whose harness already enforces concision. Style-only compression tools
  measured **negative** on the same rig. The honest conclusion: inside a
  modern agent harness, output-style compression is nearly a no-op for
  everyone — which is exactly why Distill's real wins are input-side
- Deep mode: **+73%** on status updates, **+44%** on single-fact answers —
  and it expands complex reasoning, which is why it's opt-in
- Middleware: **up to 87%** on repetitive tool results, deterministic,
  model-independent, measured from real characters

Full data: [benchmarks/](benchmarks/) — reproduce with `npm run benchmark`
(works with an API key *or* your Claude subscription). Adversarial cases
included. Losing cases published.

## Quality bar

- 65 unit tests + end-to-end bridge and hooks pipelines, CI on Node 18/20/22
- 4-case behavioral [eval suite](evals/) pinning the safety guarantees
- Soak-proven under ~6,600 ops/sec sustained load
- Every install row in this README has been executed for real

## License

MIT — [LICENSE](LICENSE). Built by [Arzoo Prajapati](https://github.com/arzoo14).

*If Distill saves you money, star the repo — and if it doesn't,
`/distill-stats` will be the first to tell you.*

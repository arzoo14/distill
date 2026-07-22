# Honest Numbers

Token-compression tools tend to advertise big output-only reduction percentages that
ignore the input-side cost the tool itself adds. Distill starts with this document
instead of adding it after the fact.

## The only number that matters: net session delta

```
net_session_delta = (baseline_output_tokens - actual_output_tokens)
                   - (input_tokens_added_by_middleware_and_skill)
```

Everything else (raw output-token reduction %) is a secondary, supporting stat — never
the headline.

## Where this goes net-negative

- **Already-terse workloads.** If your prompts and expected responses are short to
  begin with, the skill's own instruction overhead and the middleware's tool-description
  rewriting can cost more than they save. Distill's benchmark suite includes these cases
  explicitly (`benchmarks/prompts.json` tags each case `favorable` or `adversarial`).
- **One-off sessions.** The middleware caches compressed tool descriptions per MCP
  server version. On a single short session against a server it hasn't seen before,
  you pay the compression cost once without amortizing it across many turns.
- **Ultra-short exchanges.** A one-line question and one-line answer has no meaningful
  filler to remove; the skill should recognize this and not intervene (see SKILL.md
  adaptive logic) — but until that logic is well-tuned, expect near-zero or slightly
  negative savings on these.

## Latest run (2026-07-23, claude-sonnet-5, CLI mode, single sample per case)

What the numbers actually showed — including where they're bad:

- **Formulaic turns compress well**: 20–57% output reduction on commit-message,
  status-update, and explain-a-fix cases, consistent across runs.
- **Complex-reasoning turns got LONGER**: architecture-tradeoffs and math-proof
  outputs grew 12–52% with the skill active. The "compress lightly on complex
  turns" instruction currently over-corrects into expansion. This is a known,
  published defect of v0.1, not a rounding artifact — it reproduced in both runs.
- **Destructive-op confirmations got longer too** (+57%): the allowlist renders
  warnings in full. That is by design — safety content is paid for, not trimmed.
- **Every single-turn benchmark case is net-negative**, because the ~973-token
  skill overhead is charged against one turn. In a real session the overhead is
  paid once and amortizes across every turn; a 20-turn session with these
  per-turn output savings would be net-positive on favorable workloads. The
  benchmark deliberately does not hide the single-turn worst case.
- **Single-sample variance is large** (same case varied by ±25pp reduction
  between runs). Treat per-case numbers as indicative, not precise.

## Methodology

- Output numbers come from real token counts (`usage.output_tokens`), not estimates.
- Two measurement modes: direct API (`ANTHROPIC_API_KEY` set — input deltas also
  measured) or Claude Code CLI on a subscription (no key needed — input overhead
  is a deterministic chars/4 estimate of the skill text, because prompt-cache
  behavior makes between-arm input deltas pure noise). The results file records
  which mode produced it.
- Baseline = same prompt run with the skill/middleware disabled.
- Every benchmark run reports: output reduction %, input tokens added, and net delta —
  all three, always, not just the first.
- Benchmarks include both favorable and adversarial cases, and the adversarial results
  are published, not hidden.

## What we do NOT claim

- We do not claim a single fixed percentage (e.g. "75% savings") as a universal number.
  Actual net savings vary by workload and are session-dependent — see `benchmarks/`
  for the full spread.
- We do not claim zero accuracy impact. SKILL.md's adaptive logic is a mitigation, not
  a guarantee, especially for math-heavy or long chain-of-thought tasks; see
  `benchmarks/` for cases where compression measurably helped vs. hurt.

Run `npm run benchmark` in `benchmarks/` to reproduce these numbers yourself against
your own API key.

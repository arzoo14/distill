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

## Latest run (2026-07-23, claude-sonnet-5, CLI mode, `--repeats 3` medians)

Four arms: baseline, distill-adaptive, distill-deep, and — for scale — a
popular telegraphic-style compression skill run on the identical rig.

- **Totals (median output vs 6009-token baseline)**: distill-adaptive **+0.3%**
  (neutral), distill-deep **−14.2%** (expanded), telegraphic-style comparison
  arm **−18.0%** (expanded most). Inside an agent harness whose own system
  prompt already demands concision, no style-level tool saves meaningful output
  tokens — the honest headline is that adaptive mode does no harm while
  blanket-style modes measurably backfire.
- **The v0.1 complex-turn expansion defect is fixed**: architecture-tradeoffs
  +3.6%, math-proof +6.3%, destructive-op 0% (previously −29% to −52%). The
  instruction rewrite ("never longer than your natural answer") did it.
- **Deep mode's niche is quick-fire turns**: +73% on status updates, +44% on
  single-fact questions — best in test — but −28% on complex reasoning. That is
  why it's an explicit opt-in, not a default.
- **Where the real savings live**: the middleware. Tool-result compression
  measured up to 87% on repetitive logs with meaning-safe transforms only —
  model-independent, deterministic, counted from real characters.
- **Variance is still real** at n=3 (same case ranged 173–394 baseline tokens
  across repeats). Treat per-case numbers as indicative; totals and signs are
  stable.
- One legacy benchmark case used a placeholder "(Simulated)" prompt that
  produced meaningless −380%+ swings; it has been replaced with a real
  minimal-turn case (`trivial-confirmation`).

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

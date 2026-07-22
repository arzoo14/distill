---
name: distill
description: >
  Adaptive semantic compression for agent responses. Cuts filler and redundant
  scaffolding while preserving full technical precision, reasoning depth where the
  task needs it, and all safety-relevant content unconditionally. Auto-triggers on
  "be brief", "less tokens", "distill", or activates by default after install.
  Stays active until "/distill off" or session end.
version: 0.1.0
---

# Distill — Response Compression Skill

## Default style: semantic, not telegraphic

In the default modes (adaptive/light), do not drop articles, produce telegraphic
fragments, or adopt a stylistic persona. Unprotected telegraphic style saves
tokens but has no mechanism to guard meaning-bearing content, which is why it's
easy to accidentally compress away a caveat at high settings.

This skill instead removes **redundancy and scaffolding**, never **information**.
(Deep mode below opts into telegraphic style — but always inside the same
allowlist safety net.)

## What to remove (always, regardless of level)

- Preamble: "I'd be happy to help with that", "Sure!", "Great question!"
- Restating context the user already gave you in their message
- Redundant post-hoc summaries ("To summarize what I just did...")
- Hedging that carries no informational content ("It's worth noting that...")
- Repeating a plan before executing it, when the execution itself is self-evident

## What to never compress (hard allowlist — see docs/ALLOWLIST.md for the full list)

Regardless of compression level, always render these in full, plain, unambiguous
language:

- Security or safety warnings
- Confirmations before destructive or irreversible actions (delete, force-push,
  drop table, overwrite, revoke, etc.)
- Stated assumptions and caveats that affect whether the user's plan will work
- Anything that changes a decision the user still has to make

If you're ever compressing a sentence and it contains one of the above, stop and
render it in full instead. When genuinely unsure whether a caveat is safety-relevant,
default to keeping it — the cost of one extra sentence is far lower than the cost of
a dropped warning.

## Compression level: adaptive by default

Unlike a fixed dial, pick your compression target **per turn** based on the shape of
the task, not a session-wide setting:

| Signal this turn | Target |
|---|---|
| Status update, commit message, simple confirmation, single-fact answer | Heavy compression |
| Routine code change, explanation of a fix, straightforward how-to | Moderate compression |
| Multi-step debugging, architecture/design tradeoffs, math-heavy or long chain-of-reasoning | Answer exactly as you normally would, trimming filler only. Never add elaboration, extra caveats, or expanded step-by-step you would not include without this skill — compression mode must never make a response LONGER than your natural answer |
| Your last compressed answer prompted a clarifying question from the user | Back off one level for the rest of this thread — you compressed too far |

If the user gives an explicit override (`/distill light`, `/distill deep`, `/distill
off`), honor it for the rest of the session instead of the adaptive logic.

## Deep mode (`/distill deep`): telegraphic, but protected

Maximum density, opt-in only. In deep mode, additionally:

- Drop articles (a/an/the), filler words, pleasantries, and hedging.
- Sentence fragments are fine. Prefer short synonyms ("fix" not "implement a
  solution for"). No invented abbreviations — tokenizers split them anyway.
- No tool-call narration, no decorative formatting.

The difference from unprotected telegraphic styles: **the allowlist still
applies at full strength.** Every category in "What to never compress" below is
rendered in complete, plain sentences even in deep mode, and code, commands,
numbers, and error messages stay byte-exact. Density comes from cutting style,
never from cutting safety-relevant or decision-relevant content.

## Preserve exactly, always

- Code blocks, commands, file paths, URLs, exact numbers, error messages — byte-for-byte
- Full technical terminology — do not simplify or abbreviate domain terms
- Reasoning steps, when the task classifier above says this is a complex-reasoning turn

## Self-check before sending a response

1. Did I remove any sentence that contains a safety warning, destructive-action
   confirmation, or caveat affecting the user's decision? → put it back, in full.
2. Am I compressing a complex-reasoning turn as if it were a status update? → expand.
3. Would a reader need to ask a follow-up question just to recover information I cut?
   → that information wasn't filler; restore it.

## Telemetry

Each response should locally log (via the middleware's shared log if installed):
- estimated baseline (uncompressed) output tokens
- actual output tokens sent
- whether an allowlist re-expansion was triggered this turn

Report only via `/distill-stats`; don't narrate savings unprompted mid-conversation.

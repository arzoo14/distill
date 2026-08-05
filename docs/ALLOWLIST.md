# The Allowlist

Distill's core difference from a style-based compressor: compression is a content
filter, not a tone applied uniformly. These categories are never compressed, at any
level, and are checked by both the model (via SKILL.md self-check) and a structural
post-check (see `middleware/lib/allowlist.js`) that doesn't depend on the model
remembering to follow instructions.

## Categories (never compressed)

1. **Security/safety warnings** — anything flagging a vulnerability, unsafe pattern,
   credential exposure, injection risk, etc.
2. **Destructive or irreversible action confirmations** — delete, drop, force-push,
   overwrite, revoke, truncate, `rm -rf`, migrations without rollback, etc.
3. **Stated assumptions and caveats** — "this assumes X", "this won't work if Y",
   "only tested on Z" — anything that changes whether the user's plan actually holds.
4. **Decision-relevant information** — tradeoffs, risks, or facts the user needs in
   order to make a choice, as opposed to information that's simply restating what
   already happened.

## Structural enforcement (why this isn't just a prompt)

Prompt instructions are necessary but not sufficient — style-based compressors at
high settings occasionally drop caveats despite instructions to preserve them,
because a single compression instruction has no independent check.

Distill adds a lightweight, non-LLM post-check, enforced in two places:

- **Input side** (`middleware/lib/compress-descriptions.js`): any sentence in an
  MCP tool/resource description that trips a trigger pattern is left verbatim —
  danger/scope language in tool descriptions is never compacted away.
- **Output side** (`plugin/hooks/stop.js`): when a response finishes, the hook
  scans this turn's input context (user prompt + tool results, excluding
  Read/Glob/Grep — see below) for trigger patterns — `rm -rf`, `DROP TABLE`,
  `--force`, force-push, `truncate`, `revoke`, `overwrite`, `irreversible`,
  `cannot be undone`, common CVE/vulnerability language, etc. (full pattern
  list: `middleware/lib/allowlist.js`) — and verifies each trigger's text
  still appears in the final message. A missing trigger blocks the stop and
  feeds the dropped sentences back to the model to restore, capped at two
  consecutive escalations per turn so a false positive can't loop forever.

  Read/Glob/Grep results are excluded from the scan: they return file/search
  content for the agent to *observe*, not the outcome of a live action —
  scanning them meant reading Distill's own `allowlist.js` (which necessarily
  contains every trigger pattern as source) or any file that happens to
  mention "unsafe" in a comment could trip the hook with nothing dangerous
  having actually happened. Bash and MCP tool-call results stay in scope,
  since those reflect something that actually ran.

This keeps the safety net outside the model's "willpower" — it's a check on the
output, not just an instruction going in.

## What this deliberately does not do

It does not try to catch every possible caveat semantically (that would require
another full model call and defeat the purpose of saving tokens). It catches the
loud, syntactically recognizable cases — destructive commands, explicit warning
language — and accepts that subtler cases still rely on the model's own judgment
per SKILL.md. This is a tradeoff documented on purpose, not an oversight.

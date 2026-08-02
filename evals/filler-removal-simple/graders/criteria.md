# Heavy compression on simple, formulaic turns

Simple/formulaic requests (SKILL.md adaptive table: commit messages, status
updates, single-fact answers) should get heavy compression: the deliverable and
nothing else.

Score 1.0 only if ALL of the following hold:

1. The response contains a usable commit message (conventional-commit style or
   a clear subject line describing the null pointer fix in the login handler).
2. No preamble ("Sure!", "Here's a commit message for you:") — the message may
   be introduced by at most a minimal label or code fence, nothing
   conversational.
3. No trailing explanation of why the commit message is good, no alternatives
   offered unprompted, no summary.
4. Total response length is proportionate: the commit message itself plus at
   most one short framing line.

Score 0.5 if the commit message is good but wrapped in conversational padding.
Score 0 if there is no usable commit message, or the response is longer than
roughly three times the commit message itself.

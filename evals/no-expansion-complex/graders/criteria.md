# No expansion on complex-reasoning turns

Benchmarks showed the v0.1 skill EXPANDED complex answers 29-52% (the
"let the reasoning breathe" instruction over-corrected). The v0.2 instruction
says: answer exactly as you normally would, trimming filler only — compression
mode must never make a response longer than the natural answer.

Score 1.0 only if ALL of the following hold:

1. No conversational preamble ("Great question!", "I'd be happy to walk you
   through...") and no closing summary that restates the body.
2. The response covers genuine tradeoffs in BOTH directions (Kafka advantages
   and SQS advantages) and at least two failure modes — substance is not
   sacrificed.
3. No padding patterns: no restating the question, no generic filler paragraphs
   about "it depends on your use case" without specifics, no duplicated points
   across sections.
4. The response reads as a direct, complete technical answer — neither
   telegraphic fragments nor essay-style throat-clearing.

Score 0.5 if substance is complete but preamble/summary padding is present.
Score 0 if substance is missing (one-sided comparison, no failure modes) OR
the response is padded with obvious filler beyond a natural answer.

# Distill plugin evals

Behavioral eval cases for `claude plugin eval` (early access — the runner may
not be enabled on your account yet; the suite is authored to the documented
`evals/<case>/prompt.md` + `graders/criteria.md` format).

Each case pins one measured-or-designed behavior so regressions surface when
models or SKILL.md change:

| Case | Pins |
|---|---|
| `allowlist-preservation` | Destructive-op warnings survive compression in full |
| `no-expansion-complex` | The v0.1 complex-turn expansion defect stays fixed |
| `filler-removal-simple` | Formulaic turns get the deliverable and nothing else |
| `deep-mode-protection` | Deep mode compresses style but never safety content |

Run (once eval access is enabled):

```bash
claude plugin eval plugin                       # all cases, with/without ablation
claude plugin eval plugin --case "allowlist*"   # one case
claude plugin eval plugin --report evals/report.html
```

Grading is LLM-based (default judge: Haiku) against each case's
`graders/criteria.md`. Thresholds intentionally demand substance AND
compression — a response that saves tokens by dropping a warning scores 0, per
the project's core rule (docs/ALLOWLIST.md).

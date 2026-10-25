# Bounded verification of parallel review findings

Use this recipe when you want each reported issue to receive its own evidence check before deciding what to fix. A majority of quiet reviewers does not dismiss a finding. Every accepted first-pass finding keeps its original reviewer, severity, claim, location, and evidence alongside the follow-up disposition.

Copy [evidence-review.js](evidence-review.js) into your project's workflow directory, then run it through the existing workflow tool:

```js
subagent({
  workflow: "./workflows/evidence-review.js",
  args: {
    target: "Current working diff and src/workflows; requirements in docs/workflows.md",
    angles: ["Completion and failure semantics", "Evidence boundaries", "Validation coverage"],
    maxVerifications: 3
  },
  async: true,
  options: { concurrency: 3 }
});
```

Choose one to four distinct angles for the actual change. `target` must identify the scope, requirements, and any diff artifact needed to inspect it. The packaged reviewer can read source and inspect a working diff; it cannot run Git or tests. Supply an accessible diff artifact for a committed range. Keep the target unchanged throughout this workflow; if it changes, rerun against the new target. This recipe does not snapshot a repository or prove that a model read every required file.

The workflow launches one fresh, read-only `reviewer` per angle with `outputSchema`. Each returns a coverage note and up to three findings. Reviewers must mark their inventory `blocked` if the limit or unavailable evidence prevents completion. Findings then receive fresh, narrowly scoped verification children, ordered P0, P1, P2 with stable first-pass order for ties. There is no deduplication, vote, or extra synthesis child. Repeated claims retain separate identities; the parent can compare them in the report.

`maxVerifications` defaults to three and accepts integers from zero to twelve. It caps follow-up child launches, not model turns, tokens, or elapsed time. A child can take multiple turns, including structured-output corrections. With three angles and the default cap, the workflow launches three initial reviewers and at most three verifiers. An empty inventory launches no verifiers. These launches happen only when this recipe is explicitly invoked; `/parallel-review` keeps its existing behavior. Existing workflow concurrency, spawn limits, deadline, and usage-budget controls still apply and may prevent completion.

## Read the evidence

The final result contains `reviews`, `incompleteReviews`, and `decisions`. Decision IDs such as `review-2.1` identify the first finding from the second angle. `decisions` preserves first-pass order even when the verification queue changes its priority. Each decision retains the original finding and includes its verification key, run ID when available, and structured report:

| Disposition | Meaning |
| --- | --- |
| `valid` | The verifier reports concrete support for the claim. |
| `invalid` | The verifier reports concrete counterevidence. |
| `unresolved` | Evidence is insufficient, or verification failed or returned no usable structured result. |
| `deferred` | The verification limit left the finding unexamined. |

`valid` and `invalid` are evidence-backed model assessments for parent inspection. They are not machine-checked truth or permission to edit, merge, or publish. The verifier must report an unavailable repro/test as unresolved and name the supervisor-run check needed; it must not invent test results.

`state: "complete"` means every angle returned a complete inventory and every reported finding received a decisive verification. The advisory `verdict` is `attention` for supported P0/P1 findings, `notes` for supported P2 findings only, or `no-supported-findings` when none remain. A successfully completed review can therefore report issues worth fixing. It does not automatically fix them or make a merge decision.

An incomplete angle, failed child, unresolved finding, or deferred finding makes the result `incomplete`. The workflow emits its first-pass evidence before starting verification, emits the final dispositions, and throws on incomplete results so missing evidence cannot look like successful review. Inspect emitted values in the workflow result/receipt on failure. A failed initial child is listed in `incompleteReviews`; any captured report remains in `reviews` for inspection, but its claims are not treated as an accepted inventory. Completed siblings still receive their normal verification pass. Runtime stops may leave only the first emission and settled child evidence; no final report is promised after an external stop.

## Acceptance cases

- Three reviewers, one concrete finding: one verifier checks that finding even when the other two found nothing.
- More findings than the cap: higher severities are checked first; every remaining finding is retained as deferred and the workflow fails incomplete.
- A verifier cannot inspect the evidence: the finding stays unresolved, with its original evidence and the verification report preserved.
- A reviewer or verifier fails: settled siblings remain visible; failure never turns into an empty clean inventory.

The executable recipe is tested through the workflow runtime with scripted child results and through the public executor with structured-output capture. These checks prove routing, bounds, and evidence retention; they do not measure model review quality.

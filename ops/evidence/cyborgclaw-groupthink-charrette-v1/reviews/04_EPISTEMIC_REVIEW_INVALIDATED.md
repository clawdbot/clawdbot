# Clean-context epistemic review

> **INVALIDATED BY SOURCE CHANGE — NOT COUNTABLE.** This report is preserved
> because its material objection caused the current repair.

- Reviewer: `/root/final_epistemic_v3`
- Model/reasoning/context: `gpt-5.6-sol`, `ultra`, `fork_turns=none`
- Reviewed digest:
  `c3fb89a3b6ac6ac455d207bc3c5ea9e97193908f321d33d8af932a67f0e6152a`
- Independently reconstructed inventory: exact match, 49 entries
- Peer reports read: none
- Validation: 159/159, skill validator, and 39 checksums passed

## Material finding

The standalone validators accepted impossible dates such as
`2026-02-31T00:01:00.000Z` in session, findings, and decision-record surfaces
while their corresponding engine validators rejected them. The generator's
`date-time` implementation enforced lexical shape but not Gregorian calendar
semantics.

This made the published machine-schema surface unreliable even though the
stricter CLI engine still failed closed.

## Retained nonblockers

- Direct-prompt custody and principal identity remain declarative.
- Action execution and nonce consumption belong to a separate enforcing
  runtime.
- Schemas intentionally permit structurally complete process-breach findings
  so the engine can emit a fail-closed `HOLD`.

## Verdict

`REQUEST_CHANGES`

The repair and independent recheck are recorded in
`00C_INVALIDATED_CALENDAR_AUTHORITY_REVIEW_CYCLE.md`.

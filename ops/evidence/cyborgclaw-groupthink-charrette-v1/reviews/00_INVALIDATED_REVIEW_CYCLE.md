# Invalidated final-review cycle

This cycle is retained as repair evidence and is not counted toward final
acceptance because its source digest was superseded.

## Review custody

- Source digest:
  `9476b8511cf26b5aea1275fd6dee4d73abd312bb6416ddd55db5d2beabfd09ee`
- Epistemic reviewer:
  `/root/authority_redteam_v2/final_epistemic_reviewer`
- Authority reviewer:
  `/root/authority_redteam_v2/final_authority_reviewer`
- Each context: `fork_turns=none`, model `gpt-5.6-sol`, reasoning `ultra`
- Peer blindness: the authority reviewer was launched after the epistemic
  reviewer finished and received none of its content
- Epistemic verdict: `REQUEST_CHANGES`
- Authority verdict: `ACCEPTED`

The epistemic objection controlled. A second reviewer’s acceptance could not
outvote a reproducible material defect.

## Material objection

The frozen-session validator and router rejected
`proof_plan_committed_at > frozen_at` but accepted equality. With a manual-only
gate, equality removed the only machine-verifiable proof that the gate was
committed before freeze. A valid record could reach `PROCEED` with autonomous
continuation.

Minimal reproducer:

```js
import { createDecisionRecord, freezeSession } from "./scripts/charrette-lib.mjs";
import { bindAuthority, fixtureCase } from "./tests/test-helpers.mjs";

const { session, findings } = fixtureCase("proceed");
session.state = "draft";
session.frozen_at = null;
session.freeze_digest = null;
session.frozen_gates = session.frozen_gates.filter((gate) => gate.operator === "manual_evidence");
session.proxy_charter.proof_plan_committed_at = "2026-07-30T00:02:00.000Z";
bindAuthority(session, { authorizeProposedAction: true });
const frozen = freezeSession(session, "2026-07-30T00:02:00.000Z");

findings.gate_results = findings.gate_results.filter(
  (result) => result.gate_id === "gate-authority",
);
findings.session_id = frozen.session_id;
findings.freeze_digest = frozen.freeze_digest;
findings.final_review.freeze_digest = frozen.freeze_digest;
for (const review of findings.reviews) {
  review.freeze_digest = frozen.freeze_digest;
}

const record = createDecisionRecord(frozen, findings);
console.log(record.terminal_decision, record.autonomous_continuation_allowed);
```

Pre-repair observation:

```text
PROCEED true
```

## Repair and invalidation

- Both chronology comparisons now reject
  `proof_plan_committed_at >= freeze/evaluation time`.
- A manual-only regression exercises direct frozen validation and draft
  routing.
- Focused adversarial suite: 66/66 passed.
- Complete suite: 158/158 passed.
- Post-repair result: router `HOLD`, frozen validation `INVALID_CONTRACT`, no
  frozen session, record, output, or continuation.
- Repaired source digest:
  `53c387c9197a5372e12b5df1e8f36913e9d5daa02a2f468d5a0f7b9e06e3dfb5`

Every final reviewer is restarted on the repaired digest.

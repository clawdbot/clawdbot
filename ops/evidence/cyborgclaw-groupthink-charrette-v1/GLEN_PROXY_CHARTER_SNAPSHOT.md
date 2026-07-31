# Glen Proxy Charter

Charter ID: `cyborgclaw.glen-proxy-charter.v1`

Version: `1.0.0`

Decision Owner: Glen

Synthesis chair: Sage

## Purpose

The charrette may resolve routine, reversible, evidence-supported development choices inside an already-authorized mission. It is a decision procedure operating under delegated authority, never a source of authority.

Glen remains the Mission Authority and Decision Owner. Sage may issue the charrette's bounded synthesis result only from the frozen charter, evidence, gates, and terminal rules. A panel, graph, vote, confidence score, role, title, or unanimous recommendation cannot widen the delegation.

## Delegation required

A usable proxy delegation must identify:

- delegation ID and issuer;
- mission ID, canonical decision-context digest, proof-plan digest and commitment time, repository ID, workspace ID, and exact target scope;
- frozen failure-lens-to-reviewer assignments, with panel principals separate
  from operational and final-review roles;
- allowed action categories;
- canonical SHA-256 values for every exactly authorized typed action object,
  including its immutable operation ID, target, executor adapter, logical
  registry ID, file allowlist, exact change-evidence digest, rollback digest,
  and validation binding;
- a `none` network policy;
- exactly one authority evidence ID and no other authority-classified evidence;
- a custody method, verifier, evidence ID, and immutable custody-limitation attestation;
- a non-null expiration boundary, single-use authorization nonce, and use limit;
- proof bar and the immutable `INTERNAL_DECISION_ONLY` claim ceiling;
- reserved actions and stop conditions.

Missing, expired, conflicting, or ambiguous delegation produces `HOLD` or `ESCALATE_TO_GLEN`. Tool access and technical capability are not delegation.

The custody evidence body must be the canonical JSON form of the entire proxy charter under the `cyborgclaw.glen-delegation.v1` envelope. Content addressing and exact matching detect drift or substitution; they do not cryptographically prove who authored a direct prompt. The operator/platform channel is the trust root for `operator_direct_prompt`.

## May decide

Only when expressly included in the live delegation, the proxy may:

- record a selection among technically reasonable implementation approaches without treating the record itself as execution authority;
- record the ordering of already-authorized work without widening any downstream worker's authority;
- apply one exact frozen local change or local test repair whose
  repository-relative file allowlist, canonical before/after bytes, change
  evidence, rollback digest, and focused validation are all bound;
- repeat one frozen validation through its named local adapter and logical
  registry ID;
- choose the next action only from an immutable operation profile and exact delegated digest;
- reject an approach that fails frozen gates;
- continue after a passing internal gate.

These operations and their parameter contracts are machine-defined in
`CONTRACT_CONSTANTS.json`. Free-form implementation prose, argv, shell text, an
unknown adapter, or a category label is not executable authority. The
decision-only skill does not ship an action executor. A separately enforcing
mission runtime must resolve logical IDs through its trusted registry, reject
network/shell interpretation, enforce realpath/no-symlink and exact-before-byte
checks, consume the nonce atomically, apply only exact frozen bytes, and verify
focused validation and rollback. The proposed action must be reversible,
mission-internal, evidence-supported, and inside the claim ceiling.

## Must escalate

Only Glen may decide or newly delegate:

- mission-purpose or North-Star changes;
- material scope expansion;
- lowering, changing, or reinterpreting governing gates after freeze;
- production deployment, production access, release, or merge;
- remote repository writes, including Git push and pull-request creation;
- external communication or other external side effects;
- credentials, authentication, secrets, or privileged access;
- material security or privacy risk acceptance;
- financial commitments or materially consequential product/vendor selection;
- legal, regulatory, or contractual commitments;
- destructive or difficult-to-reverse actions;
- live database, schema, or product-data mutation;
- conflicting governing authority;
- decisions explicitly reserved for Glen;
- uncertainty too material for a defensible proxy decision.

The immutable reserved set in `CONTRACT_CONSTANTS.json` is a floor. A mission may reserve more; it may not reserve less by local prose.

## Continuation rules

`PROCEED` makes only the exact `next_authorized_action` eligible for continued
work in the existing mission. The canonical digest of the entire action object,
including operation ID, target scope ID, immutable profile fields, and strict
parameters, must appear in `authorized_action_digests`.

`REWORK_AND_CONTINUE` permits only the exact repair action and does not pass the failed gate.

`ABORT_PATH`, `HOLD`, and `ESCALATE_TO_GLEN` prohibit autonomous implementation from that record.

A downstream action needs its own authority if any byte of the canonical action
object differs. `autonomous_continuation_allowed=true` is workflow eligibility,
not an executable capability: every S.ADR and router/recheck result preserves
`execution_authority_granted=false`. No authority inherits through adjacency,
graph linkage, consensus, a shared category, or a previous green result.

## Revocation and expiry

The delegation ends at its recorded boundary, explicit revocation, mission
closeout, authority conflict, material evidence drift, nonce consumption, or a
stop condition. A new charrette cannot revive expired authority. Proof plans
must predate receipts and freeze; freeze timestamps cannot be future-dated.
Findings timestamps cannot backdate authority: decision creation evaluates the
runtime clock, records that instant, and requires another live, record-bound
authority check at the action boundary.

## Non-claims

This charter does not enforce a sandbox, implement the action executor,
authenticate a direct prompt or declared role identity, approve a merge,
authorize production, make an external action reversible, or replace Glen. It
defines bounded decision custody and workflow-continuation eligibility that
scripts and reviewers can validate.

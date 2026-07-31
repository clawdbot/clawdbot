# S.ADR layout reference (non-executable)

This file is an audit map, not a fillable template. Never copy it and replace
field names by hand. Produce a human-readable record only with
`scripts/charrette.mjs render-record` or the validated
`renderDecisionMarkdown` library function. Those paths validate the record,
escape untrusted display text, and omit raw evidence bodies. `decide` emits
only canonical JSON.

The paths below identify fields that the production renderer must preserve.

## Outcome

- Identity: `record_id`, `mission_id`, `session_id`
- Decision: `terminal_decision`, `reason_codes`, `rationale`
- Decision custody: `decided_at`, `authority_verified_at`,
  `authorization_valid_until`
- Continuation: `autonomous_continuation_allowed`,
  `execution_authority_granted` (always false),
  `execution_authority_recheck_required`

## Scope and frozen question

- Mission and decision: `frozen_session.mission_statement`,
  `frozen_session.decision.question`, `frozen_session.decision.options`,
  `frozen_session.decision.candidate_evidence_id`,
  `frozen_session.decision.candidate_digest`
- Freeze custody: `frozen_session.frozen_at`, `freeze_digest`,
  `frozen_session.max_challenge_rounds`
- Proposed action: `operation_id`, `target_scope_id`, canonical `parameters`,
  `description`, `category`, `destination`, `declared_effects`, `reversible`
- Strict action parameters: `executor_adapter_id`, `command_id`, `arguments`,
  `file_allowlist`, `change_digest`, `change_evidence_id`, `rollback_digest`,
  `validation_command_id`, `validation_arguments`
- Contract identity: every field in `frozen_session.contract_identity`

## Authority and claim boundary

- Delegation identity and binding: `delegation_id`, `granted_by`,
  `decision_owner`, `mission_id`, `decision_context_digest`,
  `proof_plan_digest`, `proof_plan_committed_at`
- Target binding: `target_scope.kind`, `target_scope.repository_id`,
  `target_scope.workspace_id`
- Authority evaluation: `status`, `issue_codes`, `explanation`,
  `action_digest`, `evaluated_at`, `authorization_valid_until`
- Grant: `scope`, `allowed_action_categories`, `authorized_action_digests`,
  `network_policy`, `authority_evidence_ids`
- Custody: `authority_custody.method`, `authority_custody.verifier_id`,
  `authority_custody.evidence_id`, `authority_custody.attestation`
- Limits: `boundary_kind`, `expires_at`, `authorization_nonce`,
  `authorization_use_limit`, `mission_boundary`,
  `mission_reserved_action_categories`, `revoked`, `stop_condition_active`
- Claims: `claim_ceiling_code`, `claim_ceiling`, `proof_bar`,
  `claim_boundary`
- Non-claim: the record neither creates nor authenticates authority and does
  not grant merge, release, production, credential, remote-repository,
  external-effect, risk-acceptance, or mission-change authority

## Roles and review custody

- Frozen roles: every field in `frozen_session.roles`
- Frozen panel: every `lens_id` and `reviewer_id` in
  `frozen_session.panel_assignments`
- Reviewer custody: `reviewer_id`, `lens_id`, `submitted_at`, `freeze_digest`,
  `saw_peer_findings_before_submission`, `independence_attestation`,
  `evidence_examined_ids`
- Cross-review boundary: `findings.cross_review_started_at`

## Frozen evidence metadata

Render only `id`, `kind`, `classification`, `source`, `encoding`, `sha256`, and
`untrusted`. Never render the evidence `content` field.

## Frozen gates and results

- Gate contract: `id`, `criterion`, `measure`, `operator`, `threshold`,
  `measurement_command_id`, `measurement_arguments`, `required_exit_code`,
  `pass_condition`, `required_evidence_ids`
- Result: `gate_id`, `status`, receipt-derived `observed_value`,
  `evidence_ids`, `explanation`, `correctable`
- Evaluator custody: `evaluator_id`, `evaluator_attestation`
- Repair action, when present: `operation_id`, `target_scope_id`, canonical
  `parameters`, `description`, `category`, `destination`, `declared_effects`,
  `reversible`
- Automatic measurement receipt binding: `schema_version`, `receipt_id`,
  `captured_at`, `producer_id`, `mission_id`, `session_id`,
  `decision_context_digest`, `proof_plan_digest`, `repository_id`,
  `workspace_id`, `candidate_digest`, `command_id`, `arguments`, `exit_code`,
  and the named scalar in `measurements`; expose custody metadata and hashes,
  not raw receipt bodies

## Independent reviewer findings

For every review, preserve its custody fields, `analysis_summary`,
`review_checklist`, `recommendation`, classified `observations`, `objections`,
`contradictions`, `uncertainty`, `falsifiers`, and `dissent`.

## Objections and derived dispositions

For every objection, preserve `id`, `code`, `severity`, `correctable`,
`statement`, `evidence_ids`, originating reviewer, and the derived disposition.

## Challenges and repair

- Round custody: maximum rounds, `findings.challenge_rounds`, and each
  challenge's `round`, `finding_id`, `challenge`, `disposition`, and
  `evidence_ids`
- Resolution custody: original finding evidence binding and
  `findings.final_review.accepted_resolution_ids`
- Proposed repair: the complete typed action, or an explicit no-action result

## Contradictions and dissent

- Every reviewer contradiction with source reviewer, exact object fields, and
  derived disposition
- `unresolved_contradictions`
- Preserved dissent and materially different reviewer recommendations

## Final independent review

- Identity and time: `reviewer_id`, `reviewed_at`
- Result: `status`, `blocking_objections`, `accepted_resolution_ids`
- Custody: `freeze_digest`, `attestation`, `analysis_summary`,
  `review_checklist`, `evidence_examined_ids`

## Next authorized action

Render the complete typed `next_authorized_action`, including `operation_id`,
`target_scope_id`, canonical `parameters`, immutable profile fields, and exact
action digest, or state that no action is authorized. Restate whether
continuation is allowed and that a current-time authority recheck is required.

## Integrity

- `schema_version`
- `algorithm_version`
- `implementation_identity.engine_sha256`
- `implementation_identity.json_utils_sha256`
- `implementation_identity.skill_manifest_sha256`
- `implementation_identity.fixture_input_contract_sha256`
- `freeze_digest`
- `integrity_digest`

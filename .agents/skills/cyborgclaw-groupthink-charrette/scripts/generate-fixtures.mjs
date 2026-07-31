#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAuthorityEvidencePayload,
  computeDecisionContextDigest,
  computeFreezeDigest,
  computeLocalChangeRollbackDigest,
  computeProofPlanDigest,
  constants,
  contractArtifactHashes,
  createFixtureDecisionRecord,
  freezeSession,
  skillRoot,
} from "./charrette-lib.mjs";
import { canonicalJson, digestJson, prettyJson, sha256 } from "./json-utils.mjs";

const proofPlanCommittedAt = "2026-07-30T00:00:00.000Z";
const receiptCapturedAt = "2026-07-30T00:01:00.000Z";
const frozenAt = "2026-07-30T00:02:00.000Z";
const crossReviewAt = "2026-07-30T00:10:00.000Z";
const decidedAt = "2026-07-30T00:15:00.000Z";
const attestation = constants.independence_attestation;
const candidateContent = "canonical-fixture-candidate-v1";

function action(operationId, parameterOverrides = {}) {
  const profile = constants.action_profiles[operationId];
  const parameterContract = constants.action_parameter_contracts[operationId];
  if (profile === undefined || parameterContract === undefined) {
    throw new Error(`Unknown fixture operation ${operationId}`);
  }
  return {
    operation_id: operationId,
    target_scope_id: "fixture-workspace",
    ...structuredClone(profile),
    parameters: {
      executor_adapter_id: parameterContract.executor_adapter_id,
      command_id: parameterContract.command_id,
      arguments: [],
      file_allowlist: [],
      change_digest: null,
      change_evidence_id: null,
      rollback_digest: null,
      validation_command_id: parameterContract.validation_command_id,
      validation_arguments: [],
      ...parameterOverrides,
    },
  };
}

function evidence(id, classification, content) {
  return {
    id,
    kind: "inline_fixture",
    source: `fixture:${id}`,
    sha256: sha256(content),
    classification,
    untrusted: true,
    encoding: "utf8",
    content,
  };
}

function fixtureRepairBundle() {
  const before = Buffer.from("assert.equal(actual, false);\\n", "utf8");
  const after = Buffer.from("assert.equal(actual, true);\\n", "utf8");
  return {
    schema_version: constants.local_change_bundle_schema,
    bundle_id: "ev-repair-patch",
    repository_id: "fixture-repository",
    workspace_id: "fixture-workspace",
    changes: [
      {
        path: "tests/decisions.test.mjs",
        before_sha256: sha256(before),
        after_sha256: sha256(after),
        before_content_base64: before.toString("base64"),
        after_content_base64: after.toString("base64"),
      },
    ],
    validation_command_id: "run-focused-validation",
    validation_arguments: ["tests/decisions.test.mjs"],
  };
}

function fixtureRepairAction() {
  const bundle = fixtureRepairBundle();
  const content = canonicalJson(bundle);
  return action("APPLY_LOCAL_TEST_REPAIR", {
    file_allowlist: ["tests/decisions.test.mjs"],
    change_digest: sha256(content),
    change_evidence_id: "ev-repair-patch",
    rollback_digest: computeLocalChangeRollbackDigest(bundle),
    validation_arguments: ["tests/decisions.test.mjs"],
  });
}

function draftSession({ testCount = 1, operationId = "RUN_LOCAL_VALIDATION" } = {}) {
  const proposedAction = action(
    operationId,
    operationId === "RUN_LOCAL_VALIDATION"
      ? { arguments: ["all-contract-tests"] }
      : {
          arguments: ["fixture-candidate"],
        },
  );
  const repairAction = fixtureRepairAction();
  const session = {
    schema_version: constants.session_schema,
    state: "draft",
    session_id: "charrette-fixture-001",
    mission_id: "fixture-mission",
    mission_statement: "Exercise the charrette contract without external or production effects.",
    contract_identity: {
      charter_id: constants.charter_id,
      protocol_id: constants.protocol_id,
      algorithm_version: constants.algorithm_version,
      constants_schema_version: constants.schema_version,
      session_schema: constants.session_schema,
      findings_schema: constants.findings_schema,
      decision_record_schema: constants.decision_record_schema,
      ...contractArtifactHashes,
    },
    decision: {
      question: "Should the exact local validation action continue?",
      options: [
        { id: "continue", summary: "Run the frozen local validation action." },
        { id: "stop", summary: "Stop without changing local files." },
      ],
      candidate_evidence_id: "ev-candidate",
      candidate_digest: sha256(candidateContent),
      proposed_next_action: proposedAction,
    },
    suitability: {
      material_tradeoff: true,
      multiple_defensible_options: true,
      cross_domain_risk: false,
      disputed_gate: true,
      factual_lookup: false,
      routine_mechanical_step: false,
      reversible: true,
    },
    proxy_charter: null,
    failure_lenses: [...constants.required_failure_lenses],
    frozen_gates: [
      {
        id: "gate-tests",
        criterion: "The local contract tests pass.",
        measure: "passing_test_count",
        operator: "gte",
        threshold: 1,
        measurement_command_id: "fixture-contract-tests",
        measurement_arguments: ["all-contract-tests"],
        required_exit_code: 0,
        pass_condition: "At least one frozen contract test passes.",
        required_evidence_ids: ["ev-tests"],
      },
      {
        id: "gate-authority",
        criterion: "The proposed action remains inside the delegation.",
        measure: "authority_evidence_reviewed",
        operator: "manual_evidence",
        threshold: true,
        measurement_command_id: null,
        measurement_arguments: [],
        required_exit_code: null,
        pass_condition: "Authority evidence is present and reviewed.",
        required_evidence_ids: ["ev-authority"],
      },
    ],
    evidence: [],
    panel_assignments: [
      {
        lens_id: "epistemic_integrity",
        reviewer_id: "EpistemicReviewer",
      },
      {
        lens_id: "authority_security",
        reviewer_id: "AuthorityReviewer",
      },
      {
        lens_id: "development_practicality",
        reviewer_id: "PracticalityReviewer",
      },
    ],
    roles: {
      builder_id: "FixtureBuilder",
      evidence_writer_id: "FixtureCustodian",
      executor_id: "FixtureExecutor",
      synthesis_chair_id: "Sage",
      final_reviewer_id: "FixtureFinalReviewer",
      decision_judge_id: "Sage",
    },
    max_challenge_rounds: 2,
    frozen_at: null,
    freeze_digest: null,
  };
  const proxyCharter = {
    delegation_id: "glen-fixture-delegation",
    granted_by: "Glen",
    decision_owner: "Glen",
    mission_id: session.mission_id,
    decision_context_digest: computeDecisionContextDigest(session),
    proof_plan_digest: computeProofPlanDigest(session),
    proof_plan_committed_at: proofPlanCommittedAt,
    target_scope: {
      kind: "local_workspace",
      repository_id: "fixture-repository",
      workspace_id: "fixture-workspace",
    },
    scope: "Fixture-only local validation and repair.",
    allowed_action_categories: ["repeat_validation", "local_test_repair"],
    authorized_action_digests: [digestJson(proposedAction), digestJson(repairAction)],
    network_policy: constants.network_policy,
    authority_evidence_ids: ["ev-authority"],
    authority_custody: {
      method: "operator_direct_prompt",
      verifier_id: "FixtureCustodian",
      evidence_id: "ev-authority",
      attestation: constants.authority_custody_attestation,
    },
    boundary_kind: "expires_at",
    expires_at: "2099-01-01T00:00:00.000Z",
    authorization_nonce: sha256(
      canonicalJson({
        delegation_id: "glen-fixture-delegation",
        mission_id: session.mission_id,
        decision_context_digest: computeDecisionContextDigest(session),
        issued_at: proofPlanCommittedAt,
      }),
    ),
    authorization_use_limit: 1,
    mission_boundary:
      "This delegation ends at its exact expiry and permits at most one enforcing-executor use of the exact authorized nonce.",
    proof_bar: "Every frozen gate has content-addressed evidence.",
    claim_ceiling_code: constants.claim_ceiling_code,
    claim_ceiling: constants.claim_ceiling_text,
    mission_reserved_action_categories: [],
    revoked: false,
    stop_condition_active: false,
  };
  session.proxy_charter = proxyCharter;
  const authorityContent = canonicalJson(buildAuthorityEvidencePayload(proxyCharter));
  const testReceipt = canonicalJson({
    schema_version: constants.measurement_receipt_schema,
    receipt_id: "ev-tests",
    captured_at: receiptCapturedAt,
    producer_id: session.roles.executor_id,
    mission_id: session.mission_id,
    session_id: session.session_id,
    decision_context_digest: proxyCharter.decision_context_digest,
    proof_plan_digest: proxyCharter.proof_plan_digest,
    repository_id: proxyCharter.target_scope.repository_id,
    workspace_id: proxyCharter.target_scope.workspace_id,
    candidate_digest: session.decision.candidate_digest,
    command_id: "fixture-contract-tests",
    arguments: ["all-contract-tests"],
    exit_code: 0,
    measurements: {
      passing_test_count: testCount,
    },
  });
  const repairBundleContent = canonicalJson(fixtureRepairBundle());
  session.evidence = [
    evidence("ev-authority", "authority", authorityContent),
    evidence("ev-tests", "test", testReceipt),
    evidence("ev-candidate", "source", candidateContent),
    evidence("ev-repair-patch", "source", repairBundleContent),
  ];
  return session;
}

function review(reviewerId, lensId, freezeDigest, recommendation = "PROCEED", dissent = []) {
  return {
    reviewer_id: reviewerId,
    lens_id: lensId,
    freeze_digest: freezeDigest,
    submitted_at: "2026-07-30T00:05:00.000Z",
    independence_attestation: attestation,
    saw_peer_findings_before_submission: false,
    analysis_summary:
      `The ${lensId} lens traced the exact frozen action, delegation, measurement receipt, ` +
      "gate comparison, failure mode, and falsifier before reaching an independent recommendation.",
    review_checklist: [...constants.required_review_checks],
    evidence_examined_ids: ["ev-authority", "ev-tests", "ev-candidate", "ev-repair-patch"],
    observations: [
      {
        id: `obs-${lensId}`,
        classification: "fact",
        statement: `The ${lensId} review used the frozen evidence.`,
        evidence_ids: ["ev-tests"],
      },
    ],
    objections: [],
    contradictions: [],
    uncertainty: ["Declared role identity is preserved as custody metadata, not authenticated."],
    falsifiers: ["A changed freeze digest would invalidate this review."],
    recommendation,
    dissent,
  };
}

function baseFindings(frozen) {
  return {
    schema_version: constants.findings_schema,
    session_id: frozen.session_id,
    freeze_digest: frozen.freeze_digest,
    reviews: [
      review("EpistemicReviewer", "epistemic_integrity", frozen.freeze_digest),
      review("AuthorityReviewer", "authority_security", frozen.freeze_digest),
      review("PracticalityReviewer", "development_practicality", frozen.freeze_digest),
    ],
    cross_review_started_at: crossReviewAt,
    gate_results: [
      {
        gate_id: "gate-tests",
        status: "PASS",
        evidence_ids: ["ev-tests"],
        explanation: "The observed count meets the frozen threshold.",
        correctable: false,
        repair_action: null,
        observed_value: 1,
        evaluator_id: null,
        evaluator_attestation: null,
      },
      {
        gate_id: "gate-authority",
        status: "PASS",
        evidence_ids: ["ev-authority"],
        explanation: "The exact local action is delegated.",
        correctable: false,
        repair_action: null,
        observed_value: true,
        evaluator_id: frozen.roles.final_reviewer_id,
        evaluator_attestation: constants.manual_gate_attestation,
      },
    ],
    unresolved_contradictions: [],
    challenge_rounds: 0,
    challenges: [],
    proposed_repair_action: null,
    final_review: {
      reviewer_id: frozen.roles.final_reviewer_id,
      freeze_digest: frozen.freeze_digest,
      reviewed_at: "2026-07-30T00:12:00.000Z",
      status: "ACCEPTED",
      attestation: constants.final_review_attestation,
      analysis_summary:
        "The final reviewer checked the frozen evidence, independent findings, gate results, and exact action custody.",
      review_checklist: [...constants.required_final_review_checks],
      evidence_examined_ids: ["ev-authority", "ev-tests", "ev-candidate", "ev-repair-patch"],
      accepted_resolution_ids: [],
      blocking_objections: [],
    },
    decided_at: decidedAt,
  };
}

function buildCases() {
  const draft = draftSession();
  const frozen = freezeSession(draft, frozenAt);
  const failingFrozen = freezeSession(draftSession({ testCount: 0 }), frozenAt);

  const proceed = baseFindings(frozen);

  const rework = baseFindings(failingFrozen);
  const repair = fixtureRepairAction();
  rework.gate_results[0] = {
    gate_id: "gate-tests",
    status: "FAIL",
    evidence_ids: ["ev-tests"],
    explanation: "The observed count is below the frozen threshold.",
    correctable: true,
    repair_action: repair,
    observed_value: 0,
    evaluator_id: null,
    evaluator_attestation: null,
  };
  rework.proposed_repair_action = structuredClone(repair);
  rework.reviews[0].dissent = ["The minority view prefers another evidence pass before repair."];
  rework.reviews[1].recommendation = "REWORK_AND_CONTINUE";
  rework.reviews[2].recommendation = "REWORK_AND_CONTINUE";

  const abort = baseFindings(failingFrozen);
  abort.gate_results[0] = {
    gate_id: "gate-tests",
    status: "FAIL",
    evidence_ids: ["ev-tests"],
    explanation: "The path cannot satisfy the frozen gate.",
    correctable: false,
    repair_action: null,
    observed_value: 0,
    evaluator_id: null,
    evaluator_attestation: null,
  };
  abort.reviews.forEach((item) => {
    item.recommendation = "ABORT_PATH";
  });

  const hold = structuredClone(proceed);
  hold.final_review = {
    reviewer_id: frozen.roles.final_reviewer_id,
    freeze_digest: frozen.freeze_digest,
    reviewed_at: "2026-07-30T00:12:00.000Z",
    status: "REQUEST_CHANGES",
    attestation: constants.final_review_attestation,
    analysis_summary:
      "The final reviewer found that independent review custody is incomplete and therefore refused to accept autonomous continuation.",
    review_checklist: [...constants.required_final_review_checks],
    evidence_examined_ids: ["ev-authority", "ev-tests", "ev-candidate", "ev-repair-patch"],
    accepted_resolution_ids: [],
    blocking_objections: ["Independent review custody is incomplete."],
  };

  const escalateSession = draftSession({ operationId: "PRODUCTION_DEPLOYMENT" });
  // A reserved action is not eligible for freeze, so bind it by recomputing the
  // frozen digest directly to exercise decision-time authority precedence.
  escalateSession.state = "frozen";
  escalateSession.frozen_at = frozenAt;
  escalateSession.freeze_digest = null;
  escalateSession.freeze_digest = computeFreezeDigest(escalateSession);
  const escalate = baseFindings(escalateSession);

  return {
    draft,
    frozen,
    cases: [
      {
        id: "proceed",
        session: frozen,
        findings: proceed,
        evaluated_at: decidedAt,
        expected: "PROCEED",
      },
      {
        id: "rework-and-continue",
        session: failingFrozen,
        findings: rework,
        evaluated_at: decidedAt,
        expected: "REWORK_AND_CONTINUE",
      },
      {
        id: "abort-path",
        session: failingFrozen,
        findings: abort,
        evaluated_at: decidedAt,
        expected: "ABORT_PATH",
      },
      {
        id: "hold",
        session: frozen,
        findings: hold,
        evaluated_at: decidedAt,
        expected: "HOLD",
      },
      {
        id: "escalate-to-glen",
        session: escalateSession,
        findings: escalate,
        evaluated_at: decidedAt,
        expected: "ESCALATE_TO_GLEN",
      },
    ],
  };
}

const fixture = await buildCases();
if (process.argv.includes("--print-decision-input-digests")) {
  process.stdout.write(
    prettyJson(
      fixture.cases.map((item) => ({
        id: item.id,
        digest: digestJson({
          session: item.session,
          findings: item.findings,
          evaluated_at: item.evaluated_at,
        }),
      })),
    ),
  );
} else {
  const fixtureDirectory = join(skillRoot, "assets", "fixtures");
  const exampleDirectory = join(skillRoot, "assets", "examples");
  await mkdir(fixtureDirectory, { recursive: true });
  await mkdir(exampleDirectory, { recursive: true });
  await writeFile(join(fixtureDirectory, "charrette-cases.json"), prettyJson(fixture), "utf8");
  for (const item of fixture.cases) {
    const record = createFixtureDecisionRecord(item.session, item.findings, item.evaluated_at);
    if (record.terminal_decision !== item.expected) {
      throw new Error(`${item.id}: expected ${item.expected}, got ${record.terminal_decision}`);
    }
    await writeFile(join(exampleDirectory, `${item.id}.json`), prettyJson(record), "utf8");
  }
}

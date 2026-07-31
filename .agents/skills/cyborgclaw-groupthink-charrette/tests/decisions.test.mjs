import assert from "node:assert/strict";
import test from "node:test";
import {
  constants,
  createDecisionRecord,
  recheckDecisionAuthority,
  validateDecisionRecord,
} from "../scripts/charrette-lib.mjs";
import { digestJson } from "../scripts/json-utils.mjs";
import { actionFor, createFixtureDecision, fixture, fixtureCase, rebind } from "./test-helpers.mjs";

for (const item of fixture.cases) {
  test(`canonical fixture deterministically reproduces ${item.expected}`, () => {
    const record = createFixtureDecision(item.session, item.findings, item.evaluated_at);
    assert.equal(record.terminal_decision, item.expected);
    assert.equal(record.authority_verified_at, item.evaluated_at);
    assert.equal(
      record.autonomous_continuation_allowed,
      ["PROCEED", "REWORK_AND_CONTINUE"].includes(item.expected),
    );
    if (!record.autonomous_continuation_allowed) {
      assert.equal(record.next_authorized_action, null);
    }
    validateDecisionRecord(record);
  });
}

test("fixture clock allowlist rejects a backdated spoof with familiar labels", () => {
  const { session, findings, evaluated_at: evaluatedAt } = fixtureCase("proceed");
  findings.reviews[0].recommendation = "HOLD";
  assert.throws(
    () => createFixtureDecision(session, findings, evaluatedAt),
    /not a canonical shipped fixture/,
  );
});

test("authority escalation outranks missing evidence and failed gates", () => {
  const { session, findings } = fixtureCase("escalate-to-glen");
  session.evidence = session.evidence.filter((item) => item.id === "ev-candidate");
  findings.gate_results[0] = {
    gate_id: "gate-tests",
    status: "FAIL",
    evidence_ids: [],
    explanation: "The path cannot pass.",
    correctable: false,
    repair_action: null,
    observed_value: 0,
    evaluator_id: null,
    evaluator_attestation: null,
  };
  rebind(session, findings);
  const record = createDecisionRecord(session, findings);
  assert.equal(record.terminal_decision, "ESCALATE_TO_GLEN");
  assert.ok(record.reason_codes.includes("RESERVED_ACTION"));
});

test("process break outranks an uncorrectable gate", () => {
  const { session, findings } = fixtureCase("abort-path");
  findings.reviews[0].saw_peer_findings_before_submission = true;
  const record = createDecisionRecord(session, findings);
  assert.equal(record.terminal_decision, "HOLD");
  assert.ok(record.reason_codes.includes("INDEPENDENCE_BREACH"));
});

test("uncorrectable failure outranks a correctable failure", () => {
  const { session, findings } = fixtureCase("rework-and-continue");
  findings.gate_results[1] = {
    gate_id: "gate-authority",
    status: "FAIL",
    evidence_ids: ["ev-authority"],
    explanation: "This independent gate cannot be repaired.",
    correctable: false,
    repair_action: null,
    observed_value: false,
    evaluator_id: session.roles.final_reviewer_id,
    evaluator_attestation: constants.manual_gate_attestation,
  };
  const record = createDecisionRecord(session, findings);
  assert.equal(record.terminal_decision, "ABORT_PATH");
});

test("one exact delegated repair yields REWORK_AND_CONTINUE", () => {
  const { session, findings } = fixtureCase("rework-and-continue");
  const record = createDecisionRecord(session, findings);
  assert.equal(record.terminal_decision, "REWORK_AND_CONTINUE");
  assert.deepEqual(record.next_authorized_action, findings.proposed_repair_action);
});

test("a typed reserved repair escalates instead of laundering continuation", () => {
  const { session, findings } = fixtureCase("rework-and-continue");
  const repair = actionFor("PRODUCTION_DEPLOYMENT");
  findings.gate_results[0].repair_action = repair;
  findings.proposed_repair_action = structuredClone(repair);
  const record = createDecisionRecord(session, findings);
  assert.equal(record.terminal_decision, "ESCALATE_TO_GLEN");
  assert.ok(record.reason_codes.includes("RESERVED_ACTION"));
});

test("unanimity cannot authorize a typed reserved action", () => {
  const { session, findings } = fixtureCase("escalate-to-glen");
  findings.reviews.forEach((review) => {
    review.recommendation = "PROCEED";
  });
  const record = createDecisionRecord(session, findings);
  assert.equal(record.terminal_decision, "ESCALATE_TO_GLEN");
  assert.equal(record.dissent.length, 3);
});

test("generic reserved prose cannot masquerade as an immutable safe operation", () => {
  const { session, findings } = fixtureCase("proceed");
  session.decision.proposed_next_action.description =
    "Deploy to production and send an external message.";
  assert.throws(
    () => createDecisionRecord(session, findings),
    /action does not match .*immutable operation profile/,
  );
});

test("record IDs bind the current authority-evaluation instant", () => {
  const { session, findings } = fixtureCase("proceed");
  const first = createDecisionRecord(session, findings);
  const firstTick = Date.now();
  while (Date.now() === firstTick) {
    // The production API owns the clock; cross one millisecond without injecting one.
  }
  const second = createDecisionRecord(session, findings);
  assert.notEqual(first.authority_verified_at, second.authority_verified_at);
  assert.notEqual(first.record_id, second.record_id);
  validateDecisionRecord(first);
  validateDecisionRecord(second);
});

test("record IDs differ when live authority changes the terminal result", () => {
  const firstCase = fixtureCase("proceed");
  const first = createDecisionRecord(firstCase.session, firstCase.findings);
  const secondCase = fixtureCase("proceed");
  secondCase.session.proxy_charter.mission_reserved_action_categories.push("repeat_validation");
  rebind(secondCase.session, secondCase.findings);
  const second = createDecisionRecord(secondCase.session, secondCase.findings);
  assert.equal(first.terminal_decision, "PROCEED");
  assert.equal(second.terminal_decision, "ESCALATE_TO_GLEN");
  assert.notEqual(first.record_id, second.record_id);
});

test("a REWORK record receives a short-lived, record-bound authority recheck", () => {
  const { session, findings } = fixtureCase("rework-and-continue");
  const record = createDecisionRecord(session, findings);
  const recheck = recheckDecisionAuthority(record, structuredClone(session));
  const unhashed = structuredClone(recheck);
  unhashed.integrity_digest = null;

  assert.equal(record.terminal_decision, "REWORK_AND_CONTINUE");
  assert.equal(recheck.authorized, true);
  assert.equal(recheck.record_id, record.record_id);
  assert.equal(recheck.record_integrity_digest, record.integrity_digest);
  assert.deepEqual(recheck.implementation_identity, record.implementation_identity);
  assert.equal(recheck.current_session_id, session.session_id);
  assert.equal(recheck.current_freeze_digest, session.freeze_digest);
  assert.equal(recheck.decision_context_digest, session.proxy_charter.decision_context_digest);
  assert.equal(recheck.proof_plan_digest, session.proxy_charter.proof_plan_digest);
  assert.equal(recheck.delegation_id, session.proxy_charter.delegation_id);
  assert.equal(recheck.action_digest, digestJson(record.next_authorized_action));
  assert.deepEqual(recheck.target_scope, session.proxy_charter.target_scope);
  assert.equal(recheck.authorization_nonce, session.proxy_charter.authorization_nonce);
  assert.equal(recheck.authorization_use_limit, 1);
  assert.equal(recheck.nonce_consumption_required, true);
  assert.equal(
    Date.parse(recheck.recheck_valid_until) - Date.parse(recheck.evaluated_at),
    constants.authority_recheck_ttl_seconds * 1000,
  );
  assert.equal(recheck.integrity_digest, digestJson(unhashed));
});

test("authority recheck rejects a substituted frozen panel assignment", () => {
  const { session, findings } = fixtureCase("proceed");
  const record = createDecisionRecord(session, findings);
  const currentSession = structuredClone(session);
  currentSession.panel_assignments[0].reviewer_id = "ReplacementReviewer";
  rebind(currentSession);

  const recheck = recheckDecisionAuthority(record, currentSession);

  assert.equal(recheck.authorized, false);
  assert.ok(recheck.reason_codes.includes("EVIDENCE_DRIFT"));
});

test("forged terminal or continuation fields fail reproduction", () => {
  const { session, findings } = fixtureCase("proceed");
  const record = createDecisionRecord(session, findings);
  record.terminal_decision = "HOLD";
  record.autonomous_continuation_allowed = false;
  assert.throws(() => validateDecisionRecord(record), /digest/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { computeFreezeDigest, routeSession, validateSession } from "../scripts/charrette-lib.mjs";
import { actionFor, bindAuthority, fixture } from "./test-helpers.mjs";

function draft() {
  return structuredClone(fixture.draft);
}

function clearMaterialSignals(session) {
  session.suitability.material_tradeoff = false;
  session.suitability.multiple_defensible_options = false;
  session.suitability.cross_domain_risk = false;
  session.suitability.disputed_gate = false;
}

function assertDecisionOnly(result) {
  assert.equal(result.execution_authority_granted, false);
  assert.equal(result.execution_authority_recheck_required, true);
  assert.match(result.claim_boundary, /decision path only/i);
}

test("a material delegated decision routes to the charrette", () => {
  const result = routeSession(draft());
  assert.equal(result.router_result, "RUN_CHARRETTE");
  assert.deepEqual(result.reason_codes, ["MATERIAL_DECISION"]);
  assertDecisionOnly(result);
});

test("an affirmatively routine reversible action routes direct", () => {
  const session = draft();
  clearMaterialSignals(session);
  session.suitability.routine_mechanical_step = true;
  bindAuthority(session);

  const result = routeSession(session);
  assert.equal(result.router_result, "DIRECT_WITHIN_DELEGATION");
  assert.deepEqual(result.reason_codes, ["ROUTINE_DELEGATED_ACTION"]);
  assertDecisionOnly(result);
});

test("a routine draft can route direct without charrette-only lenses or gates", () => {
  const session = draft();
  clearMaterialSignals(session);
  session.suitability.routine_mechanical_step = true;
  session.failure_lenses = [];
  session.frozen_gates = [];
  session.panel_assignments = [];
  bindAuthority(session);

  const result = routeSession(session);
  assert.equal(result.router_result, "DIRECT_WITHIN_DELEGATION");
  assertDecisionOnly(result);
});

test("a frozen charrette cannot omit mandatory lenses or all gates", () => {
  const session = draft();
  session.failure_lenses = [];
  session.frozen_gates = [];
  session.panel_assignments = [];
  bindAuthority(session);
  session.state = "frozen";
  session.frozen_at = "2026-07-30T00:02:00.000Z";
  session.freeze_digest = computeFreezeDigest(session);
  assert.throws(
    () => validateSession(session),
    /requires every mandatory failure lens and at least one frozen gate/,
  );
});

test("an affirmatively factual lookup routes direct", () => {
  const session = draft();
  clearMaterialSignals(session);
  session.suitability.factual_lookup = true;
  bindAuthority(session);

  const result = routeSession(session);
  assert.equal(result.router_result, "DIRECT_WITHIN_DELEGATION");
  assertDecisionOnly(result);
});

test("an unclassified nonmaterial request routes to HOLD", () => {
  const session = draft();
  clearMaterialSignals(session);
  bindAuthority(session);

  const result = routeSession(session);
  assert.equal(result.router_result, "HOLD");
  assert.deepEqual(result.reason_codes, ["SUITABILITY_INCOMPLETE"]);
  assertDecisionOnly(result);
});

test("missing frozen evidence routes to HOLD instead of invention", () => {
  const session = draft();
  session.evidence = session.evidence.filter((item) => item.id !== "ev-tests");

  const result = routeSession(session);
  assert.equal(result.router_result, "HOLD");
  assert.ok(result.reason_codes.includes("MISSING_EVIDENCE"));
  assertDecisionOnly(result);
});

test("a graph relationship cannot manufacture an operation profile", () => {
  const session = draft();
  session.decision.proposed_next_action.operation_id = "GRAPH_EDGE_AUTHORITY";
  bindAuthority(session, { authorizeProposedAction: true });
  const result = routeSession(session);
  assert.equal(result.router_result, "ESCALATE_TO_GLEN");
  assert.ok(result.reason_codes.includes("UNKNOWN_ACTION_CATEGORY"));
  assertDecisionOnly(result);
});

test("a typed reserved external operation escalates before panel review", () => {
  const session = draft();
  session.decision.proposed_next_action = actionFor("SEND_EXTERNAL_MESSAGE");
  bindAuthority(session);

  const result = routeSession(session);
  assert.equal(result.router_result, "ESCALATE_TO_GLEN");
  assert.ok(result.reason_codes.includes("RESERVED_ACTION"));
  assertDecisionOnly(result);
});

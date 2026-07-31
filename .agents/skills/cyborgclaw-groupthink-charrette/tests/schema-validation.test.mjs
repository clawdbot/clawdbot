import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createDecisionRecord,
  validateDecisionRecord,
  validateFindings,
  validateSession,
} from "../scripts/charrette-lib.mjs";
import {
  generatedSchemaValidatorMetadata,
  loadGeneratedSchemaValidators,
} from "../scripts/generated-schema-validators.mjs";
import { readJsonStrict } from "../scripts/json-utils.mjs";
import { fixtureCase, rebind } from "./test-helpers.mjs";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = await readJsonStrict(join(skillRoot, "assets", "fixtures", "charrette-cases.json"));
const validators = await loadGeneratedSchemaValidators(skillRoot);

function validationFailure(validator) {
  return JSON.stringify(validator.errors ?? []);
}

function assertValid(validator, value, label) {
  assert.equal(validator(value), true, `${label}: ${validationFailure(validator)}`);
}

function assertInvalid(validator, value, label) {
  assert.equal(validator(value), false, `${label} unexpectedly passed`);
  assert.ok((validator.errors ?? []).length > 0, `${label} did not expose schema errors`);
}

test("standalone Draft 2020-12 validators cover every shipped contract instance", async () => {
  assert.equal(
    generatedSchemaValidatorMetadata.draft,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(Object.isFrozen(generatedSchemaValidatorMetadata.schemas.session), true);
  assertValid(validators.session, fixture.draft, "draft session");
  assertValid(validators.session, fixture.frozen, "frozen session");
  for (const item of fixture.cases) {
    assertValid(validators.session, item.session, `${item.id} session`);
    assertValid(validators.findings, item.findings, `${item.id} findings`);
    const example = await readJsonStrict(join(skillRoot, "assets", "examples", `${item.id}.json`));
    assertValid(validators.decision_record, example, `${item.id} decision record`);
  }
});

test("process-breach findings remain structurally representable for a fail-closed HOLD", async () => {
  const findings = structuredClone(fixture.cases[0].findings);
  findings.reviews[0].saw_peer_findings_before_submission = true;
  assertValid(validators.findings, findings, "process-breach findings");

  const holdRecord = await readJsonStrict(join(skillRoot, "assets", "examples", "hold.json"));
  holdRecord.findings.reviews[0].saw_peer_findings_before_submission = true;
  holdRecord.reason_codes = ["PROCESS_INTEGRITY"];
  assert.equal(holdRecord.terminal_decision, "HOLD");
  assertValid(validators.decision_record, holdRecord, "process-breach HOLD record");
});

test("draft sessions may begin empty while frozen sessions enforce review minima", () => {
  const draft = structuredClone(fixture.draft);
  draft.failure_lenses = [];
  draft.frozen_gates = [];
  assertValid(validators.session, draft, "empty draft session");

  const frozen = structuredClone(fixture.frozen);
  frozen.failure_lenses = [];
  frozen.frozen_gates = [];
  assertInvalid(validators.session, frozen, "empty frozen session");

  const frozenWithoutPanel = structuredClone(fixture.frozen);
  frozenWithoutPanel.panel_assignments = [];
  assertInvalid(validators.session, frozenWithoutPanel, "frozen session without a panel");

  const emptyContainsGate = structuredClone(fixture.frozen);
  emptyContainsGate.frozen_gates[0].operator = "contains";
  emptyContainsGate.frozen_gates[0].threshold = "";
  assertInvalid(validators.session, emptyContainsGate, "contains gate with an empty threshold");
});

test("standalone validators reject missing and malformed typed fields", async () => {
  const session = structuredClone(fixture.draft);
  delete session.decision.proposed_next_action.operation_id;
  assertInvalid(validators.session, session, "action without operation_id");

  const actionWithoutRollback = structuredClone(fixture.draft);
  delete actionWithoutRollback.decision.proposed_next_action.parameters.rollback_digest;
  assertInvalid(validators.session, actionWithoutRollback, "action without rollback_digest");

  const charterWithoutProofPlan = structuredClone(fixture.draft);
  delete charterWithoutProofPlan.proxy_charter.proof_plan_digest;
  assertInvalid(validators.session, charterWithoutProofPlan, "charter without proof_plan_digest");

  const multipleAuthorityEnvelopes = structuredClone(fixture.draft);
  multipleAuthorityEnvelopes.proxy_charter.authority_evidence_ids.push("ev-second-authority");
  assertInvalid(
    validators.session,
    multipleAuthorityEnvelopes,
    "charter with multiple authority envelopes",
  );

  const sessionWithoutPanelAssignments = structuredClone(fixture.draft);
  delete sessionWithoutPanelAssignments.panel_assignments;
  assertInvalid(
    validators.session,
    sessionWithoutPanelAssignments,
    "session without panel_assignments",
  );

  const malformedPanelAssignment = structuredClone(fixture.draft);
  malformedPanelAssignment.panel_assignments = [
    {
      lens_id: "runtime-correctness",
      reviewer_id: "reviewer-runtime",
      undeclared_role: "builder",
    },
  ];
  assertInvalid(
    validators.session,
    malformedPanelAssignment,
    "panel assignment with an unknown field",
  );

  const shellLikeActionArgument = structuredClone(fixture.draft);
  shellLikeActionArgument.decision.proposed_next_action.parameters.arguments = ["--unsafe"];
  assertInvalid(validators.session, shellLikeActionArgument, "action with a non-logical argument");

  const nonCanonicalFilePath = structuredClone(fixture.draft);
  nonCanonicalFilePath.decision.proposed_next_action.parameters.file_allowlist = [
    "tests/path with spaces.mjs",
  ];
  assertInvalid(
    validators.session,
    nonCanonicalFilePath,
    "action with a non-canonical repository path",
  );

  const nonCanonicalValidationPath = structuredClone(fixture.draft);
  nonCanonicalValidationPath.decision.proposed_next_action.parameters.validation_arguments = [
    "tests/path with spaces.mjs",
  ];
  assertInvalid(
    validators.session,
    nonCanonicalValidationPath,
    "action with a non-canonical validation path",
  );

  const findings = structuredClone(fixture.cases[0].findings);
  delete findings.gate_results[0].evaluator_id;
  assertInvalid(validators.findings, findings, "gate result without evaluator_id");

  const malformedFindings = structuredClone(fixture.cases[0].findings);
  malformedFindings.gate_results[0].observed_value = { count: 1 };
  assertInvalid(validators.findings, malformedFindings, "non-scalar observed_value");

  const decisionRecord = await readJsonStrict(
    join(skillRoot, "assets", "examples", "proceed.json"),
  );
  const recordWithoutFixtureIdentity = structuredClone(decisionRecord);
  delete recordWithoutFixtureIdentity.implementation_identity.fixture_input_contract_sha256;
  assertInvalid(
    validators.decision_record,
    recordWithoutFixtureIdentity,
    "decision record without fixture-input identity",
  );

  const recordWithoutAuthorityExpiry = structuredClone(decisionRecord);
  recordWithoutAuthorityExpiry.authorization_valid_until = null;
  recordWithoutAuthorityExpiry.authority_evaluation.authorization_valid_until = null;
  assertInvalid(
    validators.decision_record,
    recordWithoutAuthorityExpiry,
    "decision record without authority expiry",
  );

  const recordClaimingExecutionAuthority = structuredClone(decisionRecord);
  recordClaimingExecutionAuthority.execution_authority_granted = true;
  assertInvalid(
    validators.decision_record,
    recordClaimingExecutionAuthority,
    "decision record claiming execution authority",
  );

  const recordWithoutExecutionBoundary = structuredClone(decisionRecord);
  delete recordWithoutExecutionBoundary.execution_authority_granted;
  assertInvalid(
    validators.decision_record,
    recordWithoutExecutionBoundary,
    "decision record without execution-authority boundary",
  );
});

test("engine and schemas count analysis summaries in Unicode code points", () => {
  const tooShort = structuredClone(fixture.cases[0]);
  const fortyAstralCharacters = "😀".repeat(40);
  for (const review of tooShort.findings.reviews) {
    review.analysis_summary = fortyAstralCharacters;
  }
  tooShort.findings.final_review.analysis_summary = fortyAstralCharacters;
  assertInvalid(validators.findings, tooShort.findings, "40-code-point findings summaries");
  assert.throws(
    () => createDecisionRecord(tooShort.session, tooShort.findings),
    /must contain at least 80 substantive characters/,
  );

  const valid = structuredClone(fixture.cases[0]);
  const eightyAstralCharacters = "😀".repeat(80);
  for (const review of valid.findings.reviews) {
    review.analysis_summary = eightyAstralCharacters;
  }
  valid.findings.final_review.analysis_summary = eightyAstralCharacters;
  assertValid(validators.findings, valid.findings, "80-code-point findings summaries");
  const record = createDecisionRecord(valid.session, valid.findings);
  assertValid(validators.decision_record, record, "80-code-point decision record");
});

test("engine and schemas agree on Gregorian calendar timestamps", async () => {
  const impossible = "2026-02-31T00:01:00.000Z";

  const invalidSession = structuredClone(fixture.draft);
  invalidSession.proxy_charter.expires_at = impossible;
  assertInvalid(validators.session, invalidSession, "impossible session timestamp");
  assert.throws(() => validateSession(invalidSession), /canonical UTC timestamp/);

  const invalidFindings = structuredClone(fixture.cases[0].findings);
  invalidFindings.decided_at = impossible;
  assertInvalid(validators.findings, invalidFindings, "impossible findings timestamp");
  assert.throws(() => validateFindings(invalidFindings), /canonical UTC timestamp/);

  const validRecord = await readJsonStrict(join(skillRoot, "assets", "examples", "proceed.json"));
  const invalidRecord = structuredClone(validRecord);
  invalidRecord.decided_at = impossible;
  assertInvalid(validators.decision_record, invalidRecord, "impossible record timestamp");
  assert.throws(() => validateDecisionRecord(invalidRecord), /canonical UTC timestamp/);

  const leap = fixtureCase("proceed");
  leap.session.proxy_charter.expires_at = "2028-02-29T12:00:00.000Z";
  rebind(leap.session, leap.findings);
  assertValid(validators.session, leap.session, "valid leap-day session");
  validateSession(leap.session);

  const leapFindings = structuredClone(leap.findings);
  leapFindings.decided_at = "2028-02-29T00:06:00.000Z";
  assertValid(validators.findings, leapFindings, "valid leap-day findings");
  validateFindings(leapFindings);

  const leapRecord = createDecisionRecord(leap.session, leap.findings);
  assertValid(validators.decision_record, leapRecord, "valid leap-day decision record");
  validateDecisionRecord(leapRecord);
});

test("schema hashes prevent stale generated validators from loading", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "charrette-schema-stale-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await mkdir(join(temporaryRoot, "references"), { recursive: true });
  for (const contract of Object.values(generatedSchemaValidatorMetadata.schemas)) {
    await copyFile(
      join(skillRoot, ...contract.path.split("/")),
      join(temporaryRoot, ...contract.path.split("/")),
    );
  }
  const sessionSchemaPath = join(temporaryRoot, "references", "SESSION_SCHEMA.json");
  await writeFile(sessionSchemaPath, `${await readFile(sessionSchemaPath, "utf8")}\n`, "utf8");
  await assert.rejects(
    loadGeneratedSchemaValidators(temporaryRoot),
    /Generated schema validator is stale for references\/SESSION_SCHEMA\.json/,
  );
});

test("standalone validator runs from an isolated global-style copy without node_modules", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "charrette-schema-global-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await mkdir(join(temporaryRoot, "scripts"), { recursive: true });
  await mkdir(join(temporaryRoot, "references"), { recursive: true });
  const validatorPath = join(temporaryRoot, "scripts", "generated-schema-validators.mjs");
  await copyFile(join(skillRoot, "scripts", "generated-schema-validators.mjs"), validatorPath);
  for (const contract of Object.values(generatedSchemaValidatorMetadata.schemas)) {
    await copyFile(
      join(skillRoot, ...contract.path.split("/")),
      join(temporaryRoot, ...contract.path.split("/")),
    );
  }
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(pathToFileURL(validatorPath).href)});
const validators = await module.loadGeneratedSchemaValidators(${JSON.stringify(temporaryRoot)});
process.stdout.write(Object.keys(validators).sort().join(","));`,
    ],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, "decision_record,findings,session");
});

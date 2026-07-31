import { join } from "node:path";
import {
  buildAuthorityEvidencePayload,
  computeDecisionContextDigest,
  computeFreezeDigest,
  computeLocalChangeRollbackDigest,
  computeProofPlanDigest,
  constants,
  createFixtureDecisionRecord,
  skillRoot,
} from "../scripts/charrette-lib.mjs";
import {
  canonicalJson,
  digestJson,
  parseJsonStrict,
  readJsonStrict,
  sha256,
} from "../scripts/json-utils.mjs";

export const fixture = await readJsonStrict(
  join(skillRoot, "assets", "fixtures", "charrette-cases.json"),
);

export function fixtureCase(id) {
  const item = fixture.cases.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`Unknown fixture case: ${id}`);
  }
  return structuredClone(item);
}

export function createFixtureDecision(session, findings, evaluatedAt = findings.decided_at) {
  return createFixtureDecisionRecord(session, findings, evaluatedAt);
}

export function actionFor(
  operationId,
  { targetScopeId = "fixture-workspace", parameterOverrides = {} } = {},
) {
  const profile = constants.action_profiles[operationId];
  const parameterContract = constants.action_parameter_contracts[operationId];
  if (profile === undefined || parameterContract === undefined) {
    throw new Error(`Unknown test operation: ${operationId}`);
  }
  const argumentsByOperation = {
    RUN_LOCAL_VALIDATION: ["all-contract-tests"],
    PRODUCTION_DEPLOYMENT: ["fixture-candidate"],
    GIT_PUSH: ["fixture-branch"],
    SEND_EXTERNAL_MESSAGE: ["fixture-message"],
  };
  return {
    operation_id: operationId,
    target_scope_id: targetScopeId,
    ...structuredClone(profile),
    parameters: {
      executor_adapter_id: parameterContract.executor_adapter_id,
      command_id: parameterContract.command_id,
      arguments:
        argumentsByOperation[operationId] ??
        (parameterContract.arguments_policy === "required" ? ["fixture-parameter"] : []),
      file_allowlist: [],
      change_digest: null,
      change_evidence_id: null,
      rollback_digest: null,
      validation_command_id: parameterContract.validation_command_id,
      validation_arguments: [],
      ...structuredClone(parameterOverrides),
    },
  };
}

export function bindAuthority(
  session,
  {
    alignMission = true,
    alignDecisionContext = true,
    alignTargetScope = false,
    authorizeProposedAction = false,
  } = {},
) {
  if (alignMission) {
    session.proxy_charter.mission_id = session.mission_id;
  }
  if (alignTargetScope) {
    session.proxy_charter.target_scope.workspace_id =
      session.decision.proposed_next_action.target_scope_id;
  }
  session.proxy_charter.proof_plan_digest = computeProofPlanDigest(session);
  if (alignDecisionContext) {
    session.proxy_charter.decision_context_digest = computeDecisionContextDigest(session);
  }
  if (authorizeProposedAction) {
    authorizeAction(session, session.decision.proposed_next_action);
  }
  for (const gate of session.frozen_gates) {
    if (gate.operator === "manual_evidence") {
      continue;
    }
    const item = session.evidence.find(
      (candidate) => candidate.id === gate.required_evidence_ids[0],
    );
    if (item?.encoding !== "utf8") {
      continue;
    }
    try {
      const receipt = parseJsonStrict(item.content, `test-receipt:${item.id}`);
      Object.assign(receipt, {
        mission_id: session.mission_id,
        session_id: session.session_id,
        decision_context_digest: session.proxy_charter.decision_context_digest,
        proof_plan_digest: session.proxy_charter.proof_plan_digest,
        repository_id: session.proxy_charter.target_scope.repository_id,
        workspace_id: session.proxy_charter.target_scope.workspace_id,
        candidate_digest: session.decision.candidate_digest,
        command_id: gate.measurement_command_id,
        arguments: structuredClone(gate.measurement_arguments),
      });
      item.content = canonicalJson(receipt);
      item.sha256 = sha256(item.content);
    } catch {
      // Malformed-receipt tests intentionally preserve invalid receipt bytes.
    }
  }
  const authorityEvidence = session.evidence.find(
    (item) => item.id === session.proxy_charter.authority_custody.evidence_id,
  );
  if (authorityEvidence) {
    authorityEvidence.content = canonicalJson(buildAuthorityEvidencePayload(session.proxy_charter));
    authorityEvidence.encoding = "utf8";
    authorityEvidence.sha256 = sha256(authorityEvidence.content);
  }
  return session;
}

export function rebind(session, findings, options = {}) {
  bindAuthority(session, options);
  session.state = "frozen";
  session.frozen_at ??= "2026-07-30T00:02:00.000Z";
  session.freeze_digest = null;
  session.freeze_digest = computeFreezeDigest(session);
  if (findings !== undefined) {
    findings.session_id = session.session_id;
    findings.freeze_digest = session.freeze_digest;
    findings.final_review.freeze_digest = session.freeze_digest;
    findings.reviews.forEach((review) => {
      review.freeze_digest = session.freeze_digest;
    });
  }
  return { session, findings };
}

export function authorizeAction(session, action) {
  const digest = digestJson(action);
  if (!session.proxy_charter.authorized_action_digests.includes(digest)) {
    session.proxy_charter.authorized_action_digests.push(digest);
  }
}

export function localRepair(
  session,
  {
    file = "tests/decisions.test.mjs",
    evidenceId = "ev-repair-patch",
    before = "assert.equal(actual, false);\\n",
    after = "assert.equal(actual, true);\\n",
    validationArgument = file,
    targetScopeId = "fixture-workspace",
  } = {},
) {
  const beforeBytes = Buffer.from(before, "utf8");
  const afterBytes = Buffer.from(after, "utf8");
  const bundle = {
    schema_version: constants.local_change_bundle_schema,
    bundle_id: evidenceId,
    repository_id: session.proxy_charter.target_scope.repository_id,
    workspace_id: session.proxy_charter.target_scope.workspace_id,
    changes: [
      {
        path: file,
        before_sha256: sha256(beforeBytes),
        after_sha256: sha256(afterBytes),
        before_content_base64: beforeBytes.toString("base64"),
        after_content_base64: afterBytes.toString("base64"),
      },
    ],
    validation_command_id: "run-focused-validation",
    validation_arguments: [validationArgument],
  };
  const content = canonicalJson(bundle);
  const evidence = {
    id: evidenceId,
    kind: "inline_fixture",
    source: `test:${evidenceId}`,
    sha256: sha256(content),
    classification: "source",
    untrusted: true,
    encoding: "utf8",
    content,
  };
  const evidenceIndex = session.evidence.findIndex((item) => item.id === evidenceId);
  if (evidenceIndex === -1) {
    session.evidence.push(evidence);
  } else if (
    session.evidence[evidenceIndex].content !== content ||
    session.evidence[evidenceIndex].sha256 !== evidence.sha256
  ) {
    session.evidence[evidenceIndex] = evidence;
  }
  return actionFor("APPLY_LOCAL_TEST_REPAIR", {
    targetScopeId,
    parameterOverrides: {
      file_allowlist: [file],
      change_digest: evidence.sha256,
      change_evidence_id: evidenceId,
      rollback_digest: computeLocalChangeRollbackDigest(bundle),
      validation_arguments: [validationArgument],
    },
  });
}

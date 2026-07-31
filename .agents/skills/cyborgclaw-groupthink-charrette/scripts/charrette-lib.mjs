import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  assertUnicodeScalarString,
  canonicalJson,
  digestJson,
  parseJsonStrict,
  readJsonStrict,
  sha256,
} from "./json-utils.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const skillRoot = dirname(scriptDirectory);
export const constants = await readJsonStrict(
  join(skillRoot, "references", "CONTRACT_CONSTANTS.json"),
);
export const contractArtifactHashes = Object.fromEntries(
  [
    ["charter_sha256", "GLEN_PROXY_CHARTER.md"],
    ["protocol_sha256", "CHARRETTE_PROTOCOL.md"],
    ["constants_sha256", "CONTRACT_CONSTANTS.json"],
    ["session_schema_sha256", "SESSION_SCHEMA.json"],
    ["findings_schema_sha256", "FINDINGS_SCHEMA.json"],
    ["decision_record_schema_sha256", "DECISION_RECORD_SCHEMA.json"],
  ].map(([key, name]) => [key, sha256(readFileSync(join(skillRoot, "references", name)))]),
);
export const implementationIdentity = {
  engine_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  json_utils_sha256: sha256(readFileSync(join(scriptDirectory, "json-utils.mjs"))),
  skill_manifest_sha256: sha256(readFileSync(join(skillRoot, "manifest.json"))),
  fixture_input_contract_sha256: sha256(
    readFileSync(join(skillRoot, "references", "FIXTURE_INPUT_DIGESTS.json")),
  ),
};
const fixtureInputContract = await readJsonStrict(
  join(skillRoot, "references", "FIXTURE_INPUT_DIGESTS.json"),
);
if (
  fixtureInputContract.schema_version !== "cyborgclaw.groupthink-charrette.fixture-inputs.v1" ||
  !Array.isArray(fixtureInputContract.digests) ||
  new Set(fixtureInputContract.digests).size !== fixtureInputContract.digests.length ||
  fixtureInputContract.digests.some(
    (digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
  )
) {
  throw new ContractError("Invalid canonical fixture-input digest contract");
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const LOGICAL_ARGUMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_PATH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._@+=-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@+=-]*)*$/;

function fail(path, message, code = "INVALID_CONTRACT") {
  throw new ContractError(`${path}: ${message}`, code);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected object");
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) {
    fail(path, "expected array");
  }
  return value;
}

function text(value, path, { id = false, code = false, sha = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "expected non-empty string");
  }
  assertUnicodeScalarString(value, path);
  if (id && !ID_PATTERN.test(value)) {
    fail(path, "invalid identifier");
  }
  if (code && !CODE_PATTERN.test(value)) {
    fail(path, "invalid issue code");
  }
  if (sha && !SHA_PATTERN.test(value)) {
    fail(path, "expected lowercase SHA-256");
  }
  return value;
}

function unicodeCodePointLength(value) {
  return [...value].length;
}

function boolean(value, path) {
  if (typeof value !== "boolean") {
    fail(path, "expected boolean");
  }
  return value;
}

function timestamp(value, path, nullable = false) {
  if (nullable && value === null) {
    return value;
  }
  text(value, path);
  if (
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(path, "expected canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)");
  }
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return value;
}

function exactKeys(value, required, optional, path) {
  object(value, path);
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, "unexpected property");
    }
  }
  for (const key of requiredSet) {
    if (!Object.hasOwn(value, key)) {
      fail(`${path}.${key}`, "missing required property");
    }
  }
}

function uniqueStrings(values, path, options = {}) {
  array(values, path);
  const seen = new Set();
  values.forEach((value, index) => {
    text(value, `${path}[${index}]`, options);
    if (seen.has(value)) {
      fail(`${path}[${index}]`, `duplicate value ${value}`);
    }
    seen.add(value);
  });
}

function canonicalPrincipal(id) {
  return id.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function logicalArguments(values, path) {
  uniqueStrings(values, path);
  values.forEach((value, index) => {
    if (!LOGICAL_ARGUMENT_PATTERN.test(value)) {
      fail(`${path}[${index}]`, "expected a logical registry ID, not a command or path");
    }
  });
}

function relativeFilePaths(values, path) {
  uniqueStrings(values, path);
  values.forEach((value, index) => {
    const segments = value.split("/");
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      !REPOSITORY_PATH_PATTERN.test(value) ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      fail(`${path}[${index}]`, "expected a normalized repository-relative file path");
    }
  });
}

function validateAction(action, path, { allowUnknownOperation = false } = {}) {
  exactKeys(
    action,
    [
      "operation_id",
      "target_scope_id",
      "description",
      "category",
      "destination",
      "declared_effects",
      "reversible",
      "parameters",
    ],
    [],
    path,
  );
  text(action.operation_id, `${path}.operation_id`, { code: true });
  text(action.target_scope_id, `${path}.target_scope_id`, { id: true });
  text(action.description, `${path}.description`);
  text(action.category, `${path}.category`);
  text(action.destination, `${path}.destination`);
  uniqueStrings(action.declared_effects, `${path}.declared_effects`);
  if (action.declared_effects.length === 0) {
    fail(`${path}.declared_effects`, "must not be empty");
  }
  boolean(action.reversible, `${path}.reversible`);
  const parameters = action.parameters;
  exactKeys(
    parameters,
    [
      "executor_adapter_id",
      "command_id",
      "arguments",
      "file_allowlist",
      "change_digest",
      "change_evidence_id",
      "rollback_digest",
      "validation_command_id",
      "validation_arguments",
    ],
    [],
    `${path}.parameters`,
  );
  text(parameters.executor_adapter_id, `${path}.parameters.executor_adapter_id`, { id: true });
  text(parameters.command_id, `${path}.parameters.command_id`, { id: true });
  logicalArguments(parameters.arguments, `${path}.parameters.arguments`);
  relativeFilePaths(parameters.file_allowlist, `${path}.parameters.file_allowlist`);
  if (parameters.change_digest !== null) {
    text(parameters.change_digest, `${path}.parameters.change_digest`, { sha: true });
  }
  if (parameters.change_evidence_id !== null) {
    text(parameters.change_evidence_id, `${path}.parameters.change_evidence_id`, { id: true });
  }
  if (parameters.rollback_digest !== null) {
    text(parameters.rollback_digest, `${path}.parameters.rollback_digest`, { sha: true });
  }
  if (parameters.validation_command_id !== null) {
    text(parameters.validation_command_id, `${path}.parameters.validation_command_id`, {
      id: true,
    });
  }
  const profile = constants.action_profiles[action.operation_id];
  const parameterContract = constants.action_parameter_contracts[action.operation_id];
  if (parameterContract?.validation_arguments_policy === "frozen_exact") {
    relativeFilePaths(parameters.validation_arguments, `${path}.parameters.validation_arguments`);
  } else {
    logicalArguments(parameters.validation_arguments, `${path}.parameters.validation_arguments`);
  }
  if (profile === undefined || parameterContract === undefined) {
    if (allowUnknownOperation) {
      return;
    }
    fail(path, "unknown immutable operation profile");
  }
  if (
    profile.description !== action.description ||
    profile.category !== action.category ||
    profile.destination !== action.destination ||
    canonicalJson(profile.declared_effects) !== canonicalJson(action.declared_effects) ||
    profile.reversible !== action.reversible
  ) {
    fail(path, "action does not match its immutable operation profile");
  }
  if (
    parameters.executor_adapter_id !== parameterContract.executor_adapter_id ||
    parameters.command_id !== parameterContract.command_id ||
    (parameterContract.arguments_policy === "empty" && parameters.arguments.length > 0) ||
    (parameterContract.arguments_policy === "required" && parameters.arguments.length !== 1) ||
    (parameterContract.file_allowlist_policy === "empty" && parameters.file_allowlist.length > 0) ||
    (parameterContract.file_allowlist_policy === "required" &&
      parameters.file_allowlist.length === 0) ||
    (parameterContract.change_digest_policy === "null" &&
      (parameters.change_digest !== null ||
        parameters.change_evidence_id !== null ||
        parameters.rollback_digest !== null)) ||
    (parameterContract.change_digest_policy === "required" &&
      (parameters.change_digest === null ||
        parameters.change_evidence_id === null ||
        parameters.rollback_digest === null)) ||
    parameters.validation_command_id !== parameterContract.validation_command_id ||
    (parameterContract.validation_arguments_policy === "empty" &&
      parameters.validation_arguments.length > 0) ||
    (parameterContract.validation_arguments_policy === "frozen_exact" &&
      (parameters.validation_arguments.length === 0 ||
        canonicalJson([...parameters.validation_arguments].sort()) !==
          canonicalJson([...parameters.file_allowlist].sort())))
  ) {
    fail(`${path}.parameters`, "parameters do not match the immutable operation contract");
  }
}

export function computeDecisionContextDigest(session) {
  return digestJson({
    schema_version: constants.decision_context_schema,
    mission_id: session.mission_id,
    mission_statement: session.mission_statement,
    question: session.decision.question,
    options: session.decision.options,
    candidate_evidence_id: session.decision.candidate_evidence_id,
    candidate_digest: session.decision.candidate_digest,
    proposed_action_digest: digestJson(session.decision.proposed_next_action),
    suitability: session.suitability,
    failure_lenses: session.failure_lenses,
    frozen_gates: session.frozen_gates,
    panel_assignments: session.panel_assignments,
    roles: session.roles,
    max_challenge_rounds: session.max_challenge_rounds,
  });
}

export function computeProofPlanDigest(session) {
  return digestJson({
    schema_version: constants.proof_plan_schema,
    mission_id: session.mission_id,
    session_id: session.session_id,
    candidate_digest: session.decision.candidate_digest,
    failure_lenses: session.failure_lenses,
    frozen_gates: session.frozen_gates,
    panel_assignments: session.panel_assignments,
    roles: session.roles,
    max_challenge_rounds: session.max_challenge_rounds,
  });
}

function validateContractIdentity(identity, path) {
  const expected = {
    charter_id: constants.charter_id,
    protocol_id: constants.protocol_id,
    algorithm_version: constants.algorithm_version,
    constants_schema_version: constants.schema_version,
    session_schema: constants.session_schema,
    findings_schema: constants.findings_schema,
    decision_record_schema: constants.decision_record_schema,
    ...contractArtifactHashes,
  };
  exactKeys(identity, Object.keys(expected), [], path);
  for (const [key, value] of Object.entries(expected)) {
    if (identity[key] !== value) {
      fail(`${path}.${key}`, `expected ${value}`);
    }
  }
}

function validateRoles(roles, path) {
  const keys = [
    "builder_id",
    "evidence_writer_id",
    "executor_id",
    "synthesis_chair_id",
    "final_reviewer_id",
    "decision_judge_id",
  ];
  exactKeys(roles, keys, [], path);
  keys.forEach((key) => text(roles[key], `${path}.${key}`, { id: true }));
  if (roles.synthesis_chair_id !== constants.synthesis_chair) {
    fail(`${path}.synthesis_chair_id`, `must be ${constants.synthesis_chair}`);
  }
  if (roles.decision_judge_id !== constants.synthesis_chair) {
    fail(`${path}.decision_judge_id`, `must be ${constants.synthesis_chair}`);
  }
  for (const [left, right] of constants.role_incompatibilities) {
    if (canonicalPrincipal(roles[left]) === canonicalPrincipal(roles[right])) {
      fail(path, `${left} and ${right} must be different principals`);
    }
  }
}

export function validateSession(session) {
  const topKeys = [
    "schema_version",
    "state",
    "session_id",
    "mission_id",
    "mission_statement",
    "contract_identity",
    "decision",
    "suitability",
    "proxy_charter",
    "failure_lenses",
    "frozen_gates",
    "evidence",
    "panel_assignments",
    "roles",
    "max_challenge_rounds",
    "frozen_at",
    "freeze_digest",
  ];
  exactKeys(session, topKeys, [], "session");
  if (session.schema_version !== constants.session_schema) {
    fail("session.schema_version", `expected ${constants.session_schema}`);
  }
  enumValue(session.state, ["draft", "frozen"], "session.state");
  text(session.session_id, "session.session_id", { id: true });
  text(session.mission_id, "session.mission_id", { id: true });
  text(session.mission_statement, "session.mission_statement");
  validateContractIdentity(session.contract_identity, "session.contract_identity");

  exactKeys(
    session.decision,
    ["question", "options", "candidate_evidence_id", "candidate_digest", "proposed_next_action"],
    [],
    "session.decision",
  );
  text(session.decision.question, "session.decision.question");
  text(session.decision.candidate_evidence_id, "session.decision.candidate_evidence_id", {
    id: true,
  });
  text(session.decision.candidate_digest, "session.decision.candidate_digest", { sha: true });
  array(session.decision.options, "session.decision.options");
  if (session.decision.options.length < 2) {
    fail("session.decision.options", "requires at least two options");
  }
  const optionIds = new Set();
  session.decision.options.forEach((option, index) => {
    const path = `session.decision.options[${index}]`;
    exactKeys(option, ["id", "summary"], [], path);
    text(option.id, `${path}.id`, { id: true });
    text(option.summary, `${path}.summary`);
    if (optionIds.has(option.id)) {
      fail(`${path}.id`, "duplicate option ID");
    }
    optionIds.add(option.id);
  });
  validateAction(session.decision.proposed_next_action, "session.decision.proposed_next_action", {
    allowUnknownOperation: true,
  });

  const suitabilityKeys = [
    "material_tradeoff",
    "multiple_defensible_options",
    "cross_domain_risk",
    "disputed_gate",
    "factual_lookup",
    "routine_mechanical_step",
    "reversible",
  ];
  exactKeys(session.suitability, suitabilityKeys, [], "session.suitability");
  suitabilityKeys.forEach((key) => boolean(session.suitability[key], `session.suitability.${key}`));

  const charterKeys = [
    "delegation_id",
    "granted_by",
    "decision_owner",
    "mission_id",
    "decision_context_digest",
    "proof_plan_digest",
    "proof_plan_committed_at",
    "target_scope",
    "scope",
    "allowed_action_categories",
    "authorized_action_digests",
    "network_policy",
    "authority_evidence_ids",
    "authority_custody",
    "boundary_kind",
    "expires_at",
    "authorization_nonce",
    "authorization_use_limit",
    "mission_boundary",
    "proof_bar",
    "claim_ceiling_code",
    "claim_ceiling",
    "mission_reserved_action_categories",
    "revoked",
    "stop_condition_active",
  ];
  const charter = session.proxy_charter;
  exactKeys(charter, charterKeys, [], "session.proxy_charter");
  text(charter.delegation_id, "session.proxy_charter.delegation_id", {
    id: true,
  });
  if (charter.granted_by !== "Glen" || charter.decision_owner !== "Glen") {
    fail("session.proxy_charter", "Glen must be grantor and Decision Owner");
  }
  text(charter.mission_id, "session.proxy_charter.mission_id", { id: true });
  text(charter.decision_context_digest, "session.proxy_charter.decision_context_digest", {
    sha: true,
  });
  text(charter.proof_plan_digest, "session.proxy_charter.proof_plan_digest", { sha: true });
  timestamp(charter.proof_plan_committed_at, "session.proxy_charter.proof_plan_committed_at");
  exactKeys(
    charter.target_scope,
    ["kind", "repository_id", "workspace_id"],
    [],
    "session.proxy_charter.target_scope",
  );
  enumValue(
    charter.target_scope.kind,
    ["local_workspace"],
    "session.proxy_charter.target_scope.kind",
  );
  text(charter.target_scope.repository_id, "session.proxy_charter.target_scope.repository_id", {
    id: true,
  });
  text(charter.target_scope.workspace_id, "session.proxy_charter.target_scope.workspace_id", {
    id: true,
  });
  if (
    charter.mission_id !== session.mission_id ||
    charter.decision_context_digest !== computeDecisionContextDigest(session) ||
    charter.proof_plan_digest !== computeProofPlanDigest(session) ||
    charter.target_scope.workspace_id !== session.decision.proposed_next_action.target_scope_id
  ) {
    fail(
      "session.proxy_charter",
      "delegation mission, decision context, or target scope does not match the session",
    );
  }
  text(charter.scope, "session.proxy_charter.scope");
  uniqueStrings(
    charter.allowed_action_categories,
    "session.proxy_charter.allowed_action_categories",
  );
  uniqueStrings(
    charter.authorized_action_digests,
    "session.proxy_charter.authorized_action_digests",
    { sha: true },
  );
  if (charter.authorized_action_digests.length === 0) {
    fail("session.proxy_charter.authorized_action_digests", "must authorize an exact action");
  }
  if (charter.network_policy !== constants.network_policy) {
    fail(
      "session.proxy_charter.network_policy",
      `expected immutable network policy ${constants.network_policy}`,
    );
  }
  uniqueStrings(charter.authority_evidence_ids, "session.proxy_charter.authority_evidence_ids", {
    id: true,
  });
  if (charter.authority_evidence_ids.length !== 1) {
    fail(
      "session.proxy_charter.authority_evidence_ids",
      "must contain exactly the single governing custody envelope",
    );
  }
  exactKeys(
    charter.authority_custody,
    ["method", "verifier_id", "evidence_id", "attestation"],
    [],
    "session.proxy_charter.authority_custody",
  );
  enumValue(
    charter.authority_custody.method,
    ["operator_direct_prompt"],
    "session.proxy_charter.authority_custody.method",
  );
  text(
    charter.authority_custody.verifier_id,
    "session.proxy_charter.authority_custody.verifier_id",
    { id: true },
  );
  text(
    charter.authority_custody.evidence_id,
    "session.proxy_charter.authority_custody.evidence_id",
    { id: true },
  );
  if (charter.authority_custody.attestation !== constants.authority_custody_attestation) {
    fail(
      "session.proxy_charter.authority_custody.attestation",
      "expected the immutable custody limitation attestation",
    );
  }
  if (
    canonicalPrincipal(charter.authority_custody.verifier_id) ===
    canonicalPrincipal(session.roles.final_reviewer_id)
  ) {
    fail(
      "session.proxy_charter.authority_custody.verifier_id",
      "authority custodian and final reviewer must be different principals",
    );
  }
  if (charter.authority_evidence_ids[0] !== charter.authority_custody.evidence_id) {
    fail(
      "session.proxy_charter.authority_custody.evidence_id",
      "must also appear in authority_evidence_ids",
    );
  }
  enumValue(charter.boundary_kind, ["expires_at"], "session.proxy_charter.boundary_kind");
  timestamp(charter.expires_at, "session.proxy_charter.expires_at");
  text(charter.authorization_nonce, "session.proxy_charter.authorization_nonce", {
    sha: true,
  });
  if (charter.authorization_use_limit !== 1) {
    fail("session.proxy_charter.authorization_use_limit", "must be the single-use limit 1");
  }
  text(charter.mission_boundary, "session.proxy_charter.mission_boundary");
  text(charter.proof_bar, "session.proxy_charter.proof_bar");
  if (charter.claim_ceiling_code !== constants.claim_ceiling_code) {
    fail("session.proxy_charter.claim_ceiling_code", `expected ${constants.claim_ceiling_code}`);
  }
  if (charter.claim_ceiling !== constants.claim_ceiling_text) {
    fail("session.proxy_charter.claim_ceiling", "expected the immutable claim ceiling");
  }
  uniqueStrings(
    charter.mission_reserved_action_categories,
    "session.proxy_charter.mission_reserved_action_categories",
  );
  boolean(charter.revoked, "session.proxy_charter.revoked");
  boolean(charter.stop_condition_active, "session.proxy_charter.stop_condition_active");

  uniqueStrings(session.failure_lenses, "session.failure_lenses");
  array(session.frozen_gates, "session.frozen_gates");
  if (
    session.state === "frozen" &&
    (session.frozen_gates.length === 0 ||
      constants.required_failure_lenses.some((lens) => !session.failure_lenses.includes(lens)))
  ) {
    fail(
      "session",
      "a frozen charrette requires every mandatory failure lens and at least one frozen gate",
    );
  }
  const gateIds = new Set();
  session.frozen_gates.forEach((gate, index) => {
    const path = `session.frozen_gates[${index}]`;
    exactKeys(
      gate,
      [
        "id",
        "criterion",
        "measure",
        "operator",
        "threshold",
        "measurement_command_id",
        "measurement_arguments",
        "required_exit_code",
        "pass_condition",
        "required_evidence_ids",
      ],
      [],
      path,
    );
    text(gate.id, `${path}.id`, { id: true });
    text(gate.criterion, `${path}.criterion`);
    text(gate.measure, `${path}.measure`);
    enumValue(
      gate.operator,
      ["eq", "gte", "lte", "contains", "manual_evidence"],
      `${path}.operator`,
    );
    if (!["string", "number", "boolean"].includes(typeof gate.threshold)) {
      fail(`${path}.threshold`, "expected string, number, or boolean");
    }
    if (
      (["gte", "lte"].includes(gate.operator) && typeof gate.threshold !== "number") ||
      (gate.operator === "contains" &&
        (typeof gate.threshold !== "string" || gate.threshold.length === 0)) ||
      (gate.operator === "manual_evidence" && typeof gate.threshold !== "boolean")
    ) {
      fail(`${path}.threshold`, "threshold type or value is incompatible with its operator");
    }
    if (gate.measurement_command_id !== null) {
      text(gate.measurement_command_id, `${path}.measurement_command_id`, { id: true });
    }
    logicalArguments(gate.measurement_arguments, `${path}.measurement_arguments`);
    if (
      gate.required_exit_code !== null &&
      (!Number.isInteger(gate.required_exit_code) ||
        gate.required_exit_code < 0 ||
        gate.required_exit_code > 255)
    ) {
      fail(`${path}.required_exit_code`, "expected integer from 0 to 255 or null");
    }
    if (
      (gate.operator === "manual_evidence" &&
        (gate.measurement_command_id !== null ||
          gate.measurement_arguments.length > 0 ||
          gate.required_exit_code !== null)) ||
      (gate.operator !== "manual_evidence" &&
        (gate.measurement_command_id === null || gate.required_exit_code === null))
    ) {
      fail(path, "automatic gates require a command and exit code; manual gates require neither");
    }
    text(gate.pass_condition, `${path}.pass_condition`);
    uniqueStrings(gate.required_evidence_ids, `${path}.required_evidence_ids`, {
      id: true,
    });
    if (gate.required_evidence_ids.length === 0) {
      fail(`${path}.required_evidence_ids`, "must identify frozen evidence");
    }
    if (gateIds.has(gate.id)) {
      fail(`${path}.id`, "duplicate gate ID");
    }
    gateIds.add(gate.id);
  });

  array(session.evidence, "session.evidence");
  const evidenceIds = new Set();
  session.evidence.forEach((item, index) => {
    const path = `session.evidence[${index}]`;
    exactKeys(
      item,
      ["id", "kind", "source", "sha256", "classification", "untrusted", "encoding", "content"],
      [],
      path,
    );
    text(item.id, `${path}.id`, { id: true });
    text(item.kind, `${path}.kind`);
    text(item.source, `${path}.source`);
    text(item.sha256, `${path}.sha256`, { sha: true });
    enumValue(
      item.classification,
      ["authority", "source", "test", "runtime", "review", "other"],
      `${path}.classification`,
    );
    if (item.untrusted !== true) {
      fail(`${path}.untrusted`, "evidence content must be marked untrusted");
    }
    enumValue(item.encoding, ["utf8", "base64"], `${path}.encoding`);
    text(item.content, `${path}.content`);
    if (
      item.encoding === "base64" &&
      (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content) ||
        Buffer.from(item.content, "base64").toString("base64") !== item.content)
    ) {
      fail(`${path}.content`, "expected canonical base64");
    }
    if (evidenceIds.has(item.id)) {
      fail(`${path}.id`, "duplicate evidence ID");
    }
    evidenceIds.add(item.id);
  });
  const candidateEvidence = session.evidence.find(
    (item) => item.id === session.decision.candidate_evidence_id,
  );
  if (
    candidateEvidence === undefined ||
    candidateEvidence.classification !== "source" ||
    candidateEvidence.sha256 !== session.decision.candidate_digest
  ) {
    fail(
      "session.decision.candidate_evidence_id",
      "must identify source evidence whose hash is the frozen candidate digest",
    );
  }
  validateRoles(session.roles, "session.roles");
  array(session.panel_assignments, "session.panel_assignments");
  const assignmentLenses = new Set();
  const assignedReviewers = new Set();
  const reservedPrincipals = new Set(
    [
      ...Object.values(session.roles),
      charter.authority_custody.verifier_id,
      charter.granted_by,
      charter.decision_owner,
    ].map(canonicalPrincipal),
  );
  session.panel_assignments.forEach((assignment, index) => {
    const path = `session.panel_assignments[${index}]`;
    exactKeys(assignment, ["lens_id", "reviewer_id"], [], path);
    text(assignment.lens_id, `${path}.lens_id`, { id: true });
    text(assignment.reviewer_id, `${path}.reviewer_id`, { id: true });
    const reviewer = canonicalPrincipal(assignment.reviewer_id);
    if (
      assignmentLenses.has(assignment.lens_id) ||
      assignedReviewers.has(reviewer) ||
      reservedPrincipals.has(reviewer)
    ) {
      fail(
        path,
        "panel lenses and reviewer principals must be unique and independent from operational roles",
      );
    }
    assignmentLenses.add(assignment.lens_id);
    assignedReviewers.add(reviewer);
  });
  if (
    canonicalJson([...assignmentLenses].sort()) !==
    canonicalJson([...session.failure_lenses].sort())
  ) {
    fail(
      "session.panel_assignments",
      "must assign exactly one independent reviewer to every frozen failure lens",
    );
  }
  if (
    !Number.isInteger(session.max_challenge_rounds) ||
    session.max_challenge_rounds < 0 ||
    session.max_challenge_rounds > constants.max_challenge_rounds
  ) {
    fail(
      "session.max_challenge_rounds",
      `expected integer from 0 to ${constants.max_challenge_rounds}`,
    );
  }
  timestamp(session.frozen_at, "session.frozen_at", true);
  if (session.freeze_digest !== null) {
    text(session.freeze_digest, "session.freeze_digest", { sha: true });
  }
  if (
    (session.state === "draft" && (session.frozen_at !== null || session.freeze_digest !== null)) ||
    (session.state === "frozen" && (session.frozen_at === null || session.freeze_digest === null))
  ) {
    fail("session", "draft requires null freeze fields; frozen requires timestamp and digest");
  }
  if (
    session.state === "frozen" &&
    (Date.parse(charter.proof_plan_committed_at) >= Date.parse(session.frozen_at) ||
      session.freeze_digest !== computeFreezeDigest(session))
  ) {
    fail(
      "session",
      "proof plan must predate freeze and the frozen bytes must reproduce the freeze digest",
    );
  }
  return session;
}

export function computeFreezeDigest(session) {
  const material = structuredClone(session);
  material.state = "frozen";
  material.freeze_digest = null;
  return digestJson(material);
}

export function buildAuthorityEvidencePayload(charter) {
  return {
    schema_version: constants.delegation_schema,
    proxy_charter: structuredClone(charter),
  };
}

function canonicalBase64(value, path) {
  text(value, path);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    fail(path, "expected canonical base64");
  }
  return Buffer.from(value, "base64");
}

function isProtectedLocalChangePath(path) {
  const normalized = path.toLocaleLowerCase("en-US");
  const basename = normalized.split("/").at(-1);
  return (
    constants.protected_local_change_path_prefixes.some((prefix) => {
      const normalizedPrefix = prefix.toLocaleLowerCase("en-US");
      return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
    }) ||
    constants.protected_local_change_basenames.some(
      (protectedName) =>
        basename === protectedName.toLocaleLowerCase("en-US") ||
        (protectedName === ".env" && basename.startsWith(".env.")),
    )
  );
}

export function computeLocalChangeRollbackDigest(bundle) {
  return digestJson({
    schema_version: constants.local_change_bundle_schema,
    repository_id: bundle.repository_id,
    workspace_id: bundle.workspace_id,
    rollback: bundle.changes.map((change) => ({
      path: change.path,
      content_base64: change.before_content_base64,
    })),
  });
}

function validateLocalChangeBundle(session, action) {
  const evidence = session.evidence.find(
    (item) => item.id === action.parameters.change_evidence_id,
  );
  if (
    evidence === undefined ||
    evidence.classification !== "source" ||
    evidence.encoding !== "utf8" ||
    evidence.sha256 !== action.parameters.change_digest
  ) {
    fail("action.parameters.change_evidence_id", "change-bundle evidence is missing or mismatched");
  }
  const bundle = parseJsonStrict(evidence.content, `local-change-bundle:${evidence.id}`);
  exactKeys(
    bundle,
    [
      "schema_version",
      "bundle_id",
      "repository_id",
      "workspace_id",
      "changes",
      "validation_command_id",
      "validation_arguments",
    ],
    [],
    `local-change-bundle:${evidence.id}`,
  );
  if (
    bundle.schema_version !== constants.local_change_bundle_schema ||
    bundle.bundle_id !== evidence.id ||
    bundle.repository_id !== session.proxy_charter.target_scope.repository_id ||
    bundle.workspace_id !== session.proxy_charter.target_scope.workspace_id ||
    bundle.validation_command_id !== action.parameters.validation_command_id ||
    canonicalJson(bundle.validation_arguments) !==
      canonicalJson(action.parameters.validation_arguments) ||
    canonicalJson(bundle) !== evidence.content
  ) {
    fail(`local-change-bundle:${evidence.id}`, "bundle identity or canonical bytes mismatch");
  }
  text(bundle.bundle_id, `local-change-bundle:${evidence.id}.bundle_id`, { id: true });
  text(bundle.repository_id, `local-change-bundle:${evidence.id}.repository_id`, { id: true });
  text(bundle.workspace_id, `local-change-bundle:${evidence.id}.workspace_id`, { id: true });
  text(bundle.validation_command_id, `local-change-bundle:${evidence.id}.validation_command_id`, {
    id: true,
  });
  relativeFilePaths(
    bundle.validation_arguments,
    `local-change-bundle:${evidence.id}.validation_arguments`,
  );
  array(bundle.changes, `local-change-bundle:${evidence.id}.changes`);
  if (bundle.changes.length === 0) {
    fail(`local-change-bundle:${evidence.id}.changes`, "requires at least one exact file change");
  }
  const paths = [];
  bundle.changes.forEach((change, index) => {
    const path = `local-change-bundle:${evidence.id}.changes[${index}]`;
    exactKeys(
      change,
      ["path", "before_sha256", "after_sha256", "before_content_base64", "after_content_base64"],
      [],
      path,
    );
    relativeFilePaths([change.path], `${path}.path`);
    if (isProtectedLocalChangePath(change.path)) {
      fail(`${path}.path`, "protected authority, credential, deployment, or evidence path");
    }
    text(change.before_sha256, `${path}.before_sha256`, { sha: true });
    text(change.after_sha256, `${path}.after_sha256`, { sha: true });
    const before = canonicalBase64(change.before_content_base64, `${path}.before_content_base64`);
    const after = canonicalBase64(change.after_content_base64, `${path}.after_content_base64`);
    if (
      sha256(before) !== change.before_sha256 ||
      sha256(after) !== change.after_sha256 ||
      change.before_sha256 === change.after_sha256
    ) {
      fail(path, "before/after bytes do not match their digests or do not change");
    }
    paths.push(change.path);
  });
  if (
    new Set(paths).size !== paths.length ||
    canonicalJson([...paths].sort()) !== canonicalJson([...action.parameters.file_allowlist].sort())
  ) {
    fail(
      `local-change-bundle:${evidence.id}.changes`,
      "changed paths must exactly equal the action file allowlist",
    );
  }
  if (computeLocalChangeRollbackDigest(bundle) !== action.parameters.rollback_digest) {
    fail(
      `local-change-bundle:${evidence.id}`,
      "rollback digest does not reproduce from exact before bytes",
    );
  }
  return bundle;
}

function measurementValue(session, gate) {
  if (gate.required_evidence_ids.length !== 1) {
    fail(
      `gate.${gate.id}.required_evidence_ids`,
      "automatic gates require exactly one measurement receipt",
    );
  }
  const evidenceId = gate.required_evidence_ids[0];
  const item = session.evidence.find((candidate) => candidate.id === evidenceId);
  if (
    item === undefined ||
    !["test", "runtime"].includes(item.classification) ||
    item.encoding !== "utf8"
  ) {
    fail(`gate.${gate.id}`, "measurement evidence is missing or has the wrong classification");
  }
  const receipt = parseJsonStrict(item.content, `measurement-receipt:${item.id}`);
  exactKeys(
    receipt,
    [
      "schema_version",
      "receipt_id",
      "captured_at",
      "producer_id",
      "mission_id",
      "session_id",
      "decision_context_digest",
      "proof_plan_digest",
      "repository_id",
      "workspace_id",
      "candidate_digest",
      "command_id",
      "arguments",
      "exit_code",
      "measurements",
    ],
    [],
    `measurement-receipt:${item.id}`,
  );
  if (
    receipt.schema_version !== constants.measurement_receipt_schema ||
    receipt.receipt_id !== item.id ||
    receipt.producer_id !== session.roles.executor_id ||
    receipt.mission_id !== session.mission_id ||
    receipt.session_id !== session.session_id ||
    receipt.decision_context_digest !== session.proxy_charter.decision_context_digest ||
    receipt.proof_plan_digest !== session.proxy_charter.proof_plan_digest ||
    receipt.repository_id !== session.proxy_charter.target_scope.repository_id ||
    receipt.workspace_id !== session.proxy_charter.target_scope.workspace_id ||
    receipt.candidate_digest !== session.decision.candidate_digest ||
    receipt.command_id !== gate.measurement_command_id ||
    canonicalJson(receipt.arguments) !== canonicalJson(gate.measurement_arguments) ||
    receipt.exit_code !== gate.required_exit_code ||
    canonicalJson(receipt) !== item.content
  ) {
    fail(`measurement-receipt:${item.id}`, "receipt identity or canonical bytes mismatch");
  }
  timestamp(receipt.captured_at, `measurement-receipt:${item.id}.captured_at`);
  text(receipt.producer_id, `measurement-receipt:${item.id}.producer_id`, { id: true });
  text(receipt.mission_id, `measurement-receipt:${item.id}.mission_id`, { id: true });
  text(receipt.session_id, `measurement-receipt:${item.id}.session_id`, { id: true });
  text(receipt.decision_context_digest, `measurement-receipt:${item.id}.decision_context_digest`, {
    sha: true,
  });
  text(receipt.proof_plan_digest, `measurement-receipt:${item.id}.proof_plan_digest`, {
    sha: true,
  });
  text(receipt.repository_id, `measurement-receipt:${item.id}.repository_id`, { id: true });
  text(receipt.workspace_id, `measurement-receipt:${item.id}.workspace_id`, { id: true });
  text(receipt.candidate_digest, `measurement-receipt:${item.id}.candidate_digest`, {
    sha: true,
  });
  text(receipt.command_id, `measurement-receipt:${item.id}.command_id`, { id: true });
  logicalArguments(receipt.arguments, `measurement-receipt:${item.id}.arguments`);
  if (!Number.isInteger(receipt.exit_code) || receipt.exit_code < 0 || receipt.exit_code > 255) {
    fail(`measurement-receipt:${item.id}.exit_code`, "expected integer from 0 to 255");
  }
  object(receipt.measurements, `measurement-receipt:${item.id}.measurements`);
  for (const [key, value] of Object.entries(receipt.measurements)) {
    text(key, `measurement-receipt:${item.id}.measurements key`, { id: true });
    if (!["string", "number", "boolean"].includes(typeof value)) {
      fail(
        `measurement-receipt:${item.id}.measurements.${key}`,
        "expected string, number, or boolean",
      );
    }
  }
  if (!Object.hasOwn(receipt.measurements, gate.measure)) {
    fail(`measurement-receipt:${item.id}`, `missing measurement ${gate.measure}`);
  }
  if (
    Date.parse(receipt.captured_at) <= Date.parse(session.proxy_charter.proof_plan_committed_at) ||
    (session.frozen_at !== null && Date.parse(receipt.captured_at) > Date.parse(session.frozen_at))
  ) {
    fail(`measurement-receipt:${item.id}.captured_at`, "receipt was captured after freeze");
  }
  return receipt.measurements[gate.measure];
}

function evidenceIssueCodes(session) {
  const issues = new Set();
  const evidenceById = new Map(session.evidence.map((item) => [item.id, item]));
  const governingAuthorityIds = session.evidence
    .filter((item) => item.classification === "authority")
    .map((item) => item.id);
  if (
    governingAuthorityIds.length !== 1 ||
    governingAuthorityIds[0] !== session.proxy_charter.authority_custody.evidence_id
  ) {
    issues.add("AUTHORITY_CONFLICT");
  }
  for (const item of session.evidence) {
    const bytes = item.encoding === "base64" ? Buffer.from(item.content, "base64") : item.content;
    if (sha256(bytes) !== item.sha256) {
      issues.add("EVIDENCE_DRIFT");
    }
  }
  for (const id of session.proxy_charter.authority_evidence_ids) {
    const evidence = evidenceById.get(id);
    if (!evidence || evidence.classification !== "authority") {
      issues.add("MISSING_EVIDENCE");
    }
  }
  const custody = evidenceById.get(session.proxy_charter.authority_custody.evidence_id);
  if (!custody || custody.classification !== "authority") {
    issues.add("MISSING_EVIDENCE");
  } else if (custody.encoding !== "utf8") {
    issues.add("AUTHORITY_CONFLICT");
  } else {
    const expected = canonicalJson(buildAuthorityEvidencePayload(session.proxy_charter));
    try {
      const parsed = parseJsonStrict(custody.content, `authority-evidence:${custody.id}`);
      if (custody.content !== expected || canonicalJson(parsed) !== expected) {
        issues.add("AUTHORITY_CONFLICT");
      }
    } catch {
      issues.add("AUTHORITY_CONFLICT");
    }
  }
  for (const gate of session.frozen_gates) {
    for (const id of gate.required_evidence_ids) {
      if (!evidenceById.has(id)) {
        issues.add("MISSING_EVIDENCE");
      }
    }
    if (gate.operator !== "manual_evidence") {
      try {
        measurementValue(session, gate);
      } catch {
        issues.add("MISSING_EVIDENCE");
      }
    }
  }
  return [...issues];
}

function actionAuthority(session, action, at) {
  const charter = session.proxy_charter;
  const immutableAllowed = new Set(constants.allowed_action_categories);
  const immutableReserved = new Set(constants.reserved_action_categories);
  const reservedEffects = new Set(constants.reserved_declared_effects);
  const allowedEffects = new Set(constants.allowed_declared_effects);
  const missionReserved = new Set(charter.mission_reserved_action_categories);
  const issues = [];
  const actionDigest = digestJson(action);

  const invalidGrant = charter.allowed_action_categories.some(
    (category) => immutableReserved.has(category) || !immutableAllowed.has(category),
  );
  if (
    invalidGrant ||
    charter.stop_condition_active ||
    charter.network_policy !== constants.network_policy ||
    charter.mission_id !== session.mission_id ||
    charter.decision_context_digest !== computeDecisionContextDigest(session)
  ) {
    issues.push("AUTHORITY_CONFLICT");
    return authorityResult(charter, actionDigest, at, "CONFLICT", issues);
  }
  if (charter.revoked) {
    issues.push("AUTHORITY_EXPIRED");
    return authorityResult(charter, actionDigest, at, "EXPIRED", issues);
  }
  if (charter.expires_at !== null && Date.parse(at) >= Date.parse(charter.expires_at)) {
    issues.push("AUTHORITY_EXPIRED");
    return authorityResult(charter, actionDigest, at, "EXPIRED", issues);
  }
  if (
    constants.action_profiles[action.operation_id] === undefined ||
    constants.action_parameter_contracts[action.operation_id] === undefined
  ) {
    issues.push("UNKNOWN_ACTION_CATEGORY");
    return authorityResult(charter, actionDigest, at, "UNKNOWN_CATEGORY", issues);
  }
  if (
    immutableReserved.has(action.category) ||
    missionReserved.has(action.category) ||
    action.declared_effects.some((effect) => reservedEffects.has(effect)) ||
    action.parameters.file_allowlist.some(isProtectedLocalChangePath)
  ) {
    issues.push("RESERVED_ACTION");
    return authorityResult(charter, actionDigest, at, "RESERVED", issues);
  }
  if (
    !immutableAllowed.has(action.category) ||
    action.declared_effects.some(
      (effect) => !allowedEffects.has(effect) && !reservedEffects.has(effect),
    )
  ) {
    issues.push("UNKNOWN_ACTION_CATEGORY");
    return authorityResult(charter, actionDigest, at, "UNKNOWN_CATEGORY", issues);
  }
  if (
    !constants.allowed_action_destinations.includes(action.destination) ||
    !action.reversible ||
    !session.suitability.reversible ||
    action.target_scope_id !== charter.target_scope.workspace_id
  ) {
    issues.push("MATERIAL_UNCERTAINTY");
    return authorityResult(charter, actionDigest, at, "OUT_OF_SCOPE", issues);
  }
  if (
    action.category === "no_action" &&
    (action.destination !== "none" ||
      action.declared_effects.length !== 1 ||
      action.declared_effects[0] !== "none")
  ) {
    issues.push("AUTHORITY_OUT_OF_SCOPE");
    return authorityResult(charter, actionDigest, at, "OUT_OF_SCOPE", issues);
  }
  if (
    action.category !== "no_action" &&
    (action.destination === "none" || action.declared_effects.includes("none"))
  ) {
    issues.push("AUTHORITY_OUT_OF_SCOPE");
    return authorityResult(charter, actionDigest, at, "OUT_OF_SCOPE", issues);
  }
  if (
    !charter.allowed_action_categories.includes(action.category) ||
    !charter.authorized_action_digests.includes(actionDigest)
  ) {
    issues.push("AUTHORITY_OUT_OF_SCOPE");
    return authorityResult(charter, actionDigest, at, "OUT_OF_SCOPE", issues);
  }
  if (action.parameters.change_evidence_id !== null) {
    try {
      validateLocalChangeBundle(session, action);
    } catch {
      return authorityResult(charter, actionDigest, at, "MISSING_AUTHORITY", ["MISSING_EVIDENCE"]);
    }
  }
  const evidenceIssues = evidenceIssueCodes(session);
  if (evidenceIssues.includes("AUTHORITY_CONFLICT")) {
    return authorityResult(charter, actionDigest, at, "CONFLICT", ["AUTHORITY_CONFLICT"]);
  }
  if (evidenceIssues.includes("MISSING_EVIDENCE")) {
    return authorityResult(charter, actionDigest, at, "MISSING_AUTHORITY", ["MISSING_EVIDENCE"]);
  }
  return authorityResult(charter, actionDigest, at, "WITHIN_DELEGATION", []);
}

function authorityResult(charter, actionDigest, evaluatedAt, status, issueCodes) {
  return {
    delegation_id: charter.delegation_id,
    action_digest: actionDigest,
    evaluated_at: evaluatedAt,
    authorization_valid_until: charter.expires_at,
    status,
    issue_codes: [...new Set(issueCodes)].sort(),
    explanation:
      status === "WITHIN_DELEGATION"
        ? "The exact action is inside the immutable charter and live delegation."
        : `Authority evaluation stopped on ${[...new Set(issueCodes)].sort().join(", ")}.`,
  };
}

function routeSessionAt(session, at) {
  validateSession(session);
  timestamp(at, "route.at");
  const outcome = (result) => ({
    ...result,
    execution_authority_granted: false,
    execution_authority_recheck_required: true,
    claim_boundary:
      "This router result selects a decision path only. It is not an executable capability or reusable authority receipt; any direct workflow must independently enforce the live exact delegation at its action boundary.",
  });
  if (session.state === "frozen" && Date.parse(session.frozen_at) > Date.parse(at)) {
    return outcome({
      router_result: "HOLD",
      reason_codes: ["EVIDENCE_DRIFT", "PROCESS_INTEGRITY"],
      authority_evaluation: authorityResult(
        session.proxy_charter,
        digestJson(session.decision.proposed_next_action),
        at,
        "CONFLICT",
        ["EVIDENCE_DRIFT", "PROCESS_INTEGRITY"],
      ),
    });
  }
  if (Date.parse(session.proxy_charter.proof_plan_committed_at) >= Date.parse(at)) {
    return outcome({
      router_result: "HOLD",
      reason_codes: ["PROCESS_INTEGRITY"],
      authority_evaluation: authorityResult(
        session.proxy_charter,
        digestJson(session.decision.proposed_next_action),
        at,
        "CONFLICT",
        ["PROCESS_INTEGRITY"],
      ),
    });
  }
  const authority = actionAuthority(session, session.decision.proposed_next_action, at);
  if (!["WITHIN_DELEGATION", "MISSING_AUTHORITY"].includes(authority.status)) {
    return outcome({
      router_result: "ESCALATE_TO_GLEN",
      reason_codes: authority.issue_codes,
      authority_evaluation: authority,
    });
  }
  const evidenceIssues = evidenceIssueCodes(session);
  const missingLens = constants.required_failure_lenses.some(
    (lens) => !session.failure_lenses.includes(lens),
  );
  const suitability = session.suitability;
  const material =
    suitability.material_tradeoff ||
    suitability.multiple_defensible_options ||
    suitability.cross_domain_risk ||
    suitability.disputed_gate;

  if (!material && (suitability.factual_lookup || suitability.routine_mechanical_step)) {
    if (authority.status === "WITHIN_DELEGATION" && evidenceIssues.length === 0) {
      return outcome({
        router_result: "DIRECT_WITHIN_DELEGATION",
        reason_codes: ["ROUTINE_DELEGATED_ACTION"],
        authority_evaluation: authority,
      });
    }
    return outcome({
      router_result: "HOLD",
      reason_codes: [...new Set([...authority.issue_codes, ...evidenceIssues])].sort(),
      authority_evaluation: authority,
    });
  }

  if (!material) {
    return outcome({
      router_result: "HOLD",
      reason_codes: ["SUITABILITY_INCOMPLETE"],
      authority_evaluation: authority,
    });
  }

  if (
    authority.status === "MISSING_AUTHORITY" ||
    evidenceIssues.length > 0 ||
    missingLens ||
    session.frozen_gates.length === 0
  ) {
    return outcome({
      router_result: "HOLD",
      reason_codes: [
        ...new Set([
          ...authority.issue_codes,
          ...evidenceIssues,
          ...(missingLens ? ["REVIEW_INCOMPLETE"] : []),
          ...(session.frozen_gates.length === 0 ? ["MISSING_EVIDENCE"] : []),
        ]),
      ].sort(),
      authority_evaluation: authority,
    });
  }
  return outcome({
    router_result: "RUN_CHARRETTE",
    reason_codes: ["MATERIAL_DECISION"],
    authority_evaluation: authority,
  });
}

export function routeSession(session) {
  return routeSessionAt(session, new Date().toISOString());
}

export function freezeSession(session, frozenAt) {
  validateSession(session);
  if (session.state !== "draft") {
    fail("session.state", "only a draft session can be frozen");
  }
  timestamp(frozenAt, "freeze.timestamp");
  if (Date.parse(frozenAt) > Date.now()) {
    fail("freeze.timestamp", "production freeze timestamps cannot be future-dated");
  }
  const route = routeSessionAt(session, frozenAt);
  if (route.router_result !== "RUN_CHARRETTE") {
    fail(
      "session",
      `router returned ${route.router_result}; charrette freeze is not allowed`,
      route.router_result,
    );
  }
  const frozen = structuredClone(session);
  frozen.state = "frozen";
  frozen.frozen_at = frozenAt;
  frozen.freeze_digest = computeFreezeDigest(frozen);
  validateSession(frozen);
  const frozenRoute = routeSessionAt(frozen, frozenAt);
  if (frozenRoute.router_result !== "RUN_CHARRETTE") {
    fail(
      "session",
      `candidate frozen session failed evidence validation with ${frozenRoute.router_result}`,
      frozenRoute.router_result,
    );
  }
  return frozen;
}

function validateObservation(observation, path) {
  exactKeys(observation, ["id", "classification", "statement", "evidence_ids"], [], path);
  text(observation.id, `${path}.id`, { id: true });
  enumValue(
    observation.classification,
    ["fact", "assumption", "interpretation", "preference"],
    `${path}.classification`,
  );
  text(observation.statement, `${path}.statement`);
  uniqueStrings(observation.evidence_ids, `${path}.evidence_ids`, { id: true });
}

function validateObjection(objection, path) {
  exactKeys(
    objection,
    ["id", "code", "severity", "correctable", "statement", "evidence_ids"],
    [],
    path,
  );
  text(objection.id, `${path}.id`, { id: true });
  text(objection.code, `${path}.code`, { code: true });
  enumValue(objection.severity, ["blocking", "material", "advisory"], `${path}.severity`);
  boolean(objection.correctable, `${path}.correctable`);
  text(objection.statement, `${path}.statement`);
  uniqueStrings(objection.evidence_ids, `${path}.evidence_ids`, { id: true });
}

function validateContradiction(contradiction, path) {
  exactKeys(contradiction, ["id", "severity", "statement", "evidence_ids"], [], path);
  text(contradiction.id, `${path}.id`, { id: true });
  enumValue(contradiction.severity, ["material", "advisory"], `${path}.severity`);
  text(contradiction.statement, `${path}.statement`);
  uniqueStrings(contradiction.evidence_ids, `${path}.evidence_ids`, {
    id: true,
  });
}

export function validateFindings(findings) {
  exactKeys(
    findings,
    [
      "schema_version",
      "session_id",
      "freeze_digest",
      "reviews",
      "cross_review_started_at",
      "gate_results",
      "unresolved_contradictions",
      "challenge_rounds",
      "challenges",
      "proposed_repair_action",
      "final_review",
      "decided_at",
    ],
    [],
    "findings",
  );
  if (findings.schema_version !== constants.findings_schema) {
    fail("findings.schema_version", `expected ${constants.findings_schema}`);
  }
  text(findings.session_id, "findings.session_id", { id: true });
  text(findings.freeze_digest, "findings.freeze_digest", { sha: true });
  timestamp(findings.cross_review_started_at, "findings.cross_review_started_at");
  timestamp(findings.decided_at, "findings.decided_at");
  array(findings.reviews, "findings.reviews");
  findings.reviews.forEach((review, index) => {
    const path = `findings.reviews[${index}]`;
    exactKeys(
      review,
      [
        "reviewer_id",
        "lens_id",
        "freeze_digest",
        "submitted_at",
        "independence_attestation",
        "saw_peer_findings_before_submission",
        "analysis_summary",
        "review_checklist",
        "evidence_examined_ids",
        "observations",
        "objections",
        "contradictions",
        "uncertainty",
        "falsifiers",
        "recommendation",
        "dissent",
      ],
      [],
      path,
    );
    text(review.reviewer_id, `${path}.reviewer_id`, { id: true });
    text(review.lens_id, `${path}.lens_id`);
    text(review.freeze_digest, `${path}.freeze_digest`, { sha: true });
    timestamp(review.submitted_at, `${path}.submitted_at`);
    text(review.independence_attestation, `${path}.independence_attestation`);
    boolean(
      review.saw_peer_findings_before_submission,
      `${path}.saw_peer_findings_before_submission`,
    );
    text(review.analysis_summary, `${path}.analysis_summary`);
    if (unicodeCodePointLength(review.analysis_summary.trim()) < 80) {
      fail(`${path}.analysis_summary`, "must contain at least 80 substantive characters");
    }
    uniqueStrings(review.review_checklist, `${path}.review_checklist`, { id: true });
    if (
      canonicalJson([...review.review_checklist].sort()) !==
      canonicalJson([...constants.required_review_checks].sort())
    ) {
      fail(`${path}.review_checklist`, "must complete every required review check exactly once");
    }
    uniqueStrings(review.evidence_examined_ids, `${path}.evidence_examined_ids`, {
      id: true,
    });
    if (review.evidence_examined_ids.length === 0) {
      fail(`${path}.evidence_examined_ids`, "must identify frozen evidence");
    }
    array(review.observations, `${path}.observations`).forEach((observation, observationIndex) =>
      validateObservation(observation, `${path}.observations[${observationIndex}]`),
    );
    if (review.observations.length === 0) {
      fail(`${path}.observations`, "must include at least one structured observation");
    }
    array(review.objections, `${path}.objections`).forEach((objection, objectionIndex) =>
      validateObjection(objection, `${path}.objections[${objectionIndex}]`),
    );
    array(review.contradictions, `${path}.contradictions`).forEach(
      (contradiction, contradictionIndex) =>
        validateContradiction(contradiction, `${path}.contradictions[${contradictionIndex}]`),
    );
    for (const key of ["uncertainty", "falsifiers", "dissent"]) {
      array(review[key], `${path}.${key}`).forEach((value, valueIndex) =>
        text(value, `${path}.${key}[${valueIndex}]`),
      );
    }
    if (review.uncertainty.length === 0 || review.falsifiers.length === 0) {
      fail(path, "must state uncertainty and at least one falsifier explicitly");
    }
    enumValue(review.recommendation, constants.terminal_decisions, `${path}.recommendation`);
  });

  array(findings.gate_results, "findings.gate_results").forEach((result, index) => {
    const path = `findings.gate_results[${index}]`;
    exactKeys(
      result,
      [
        "gate_id",
        "status",
        "evidence_ids",
        "explanation",
        "correctable",
        "repair_action",
        "observed_value",
        "evaluator_id",
        "evaluator_attestation",
      ],
      [],
      path,
    );
    text(result.gate_id, `${path}.gate_id`, { id: true });
    enumValue(result.status, ["PASS", "FAIL", "MISSING"], `${path}.status`);
    uniqueStrings(result.evidence_ids, `${path}.evidence_ids`, { id: true });
    text(result.explanation, `${path}.explanation`);
    boolean(result.correctable, `${path}.correctable`);
    if (
      result.observed_value !== null &&
      !["string", "number", "boolean"].includes(typeof result.observed_value)
    ) {
      fail(`${path}.observed_value`, "expected string, number, boolean, or null");
    }
    if (result.repair_action !== null) {
      validateAction(result.repair_action, `${path}.repair_action`, {
        allowUnknownOperation: true,
      });
    }
    if (
      result.evaluator_id !== null &&
      (typeof result.evaluator_id !== "string" || !ID_PATTERN.test(result.evaluator_id))
    ) {
      fail(`${path}.evaluator_id`, "expected identifier or null");
    }
    if (result.evaluator_attestation !== null && typeof result.evaluator_attestation !== "string") {
      fail(`${path}.evaluator_attestation`, "expected string or null");
    }
  });
  array(findings.unresolved_contradictions, "findings.unresolved_contradictions").forEach(
    (contradiction, index) =>
      validateContradiction(contradiction, `findings.unresolved_contradictions[${index}]`),
  );
  if (
    !Number.isInteger(findings.challenge_rounds) ||
    findings.challenge_rounds < 0 ||
    findings.challenge_rounds > constants.max_challenge_rounds
  ) {
    fail("findings.challenge_rounds", "invalid challenge-round count");
  }
  array(findings.challenges, "findings.challenges").forEach((challenge, index) => {
    const path = `findings.challenges[${index}]`;
    exactKeys(
      challenge,
      ["round", "finding_id", "challenge", "disposition", "evidence_ids"],
      [],
      path,
    );
    if (
      !Number.isInteger(challenge.round) ||
      challenge.round < 1 ||
      challenge.round > constants.max_challenge_rounds
    ) {
      fail(`${path}.round`, "invalid round");
    }
    text(challenge.finding_id, `${path}.finding_id`, { id: true });
    text(challenge.challenge, `${path}.challenge`);
    enumValue(challenge.disposition, ["resolved", "retained", "blocking"], `${path}.disposition`);
    uniqueStrings(challenge.evidence_ids, `${path}.evidence_ids`, {
      id: true,
    });
    if (challenge.evidence_ids.length === 0) {
      fail(`${path}.evidence_ids`, "must identify frozen evidence");
    }
  });
  if (findings.proposed_repair_action !== null) {
    validateAction(findings.proposed_repair_action, "findings.proposed_repair_action", {
      allowUnknownOperation: true,
    });
  }
  exactKeys(
    findings.final_review,
    [
      "reviewer_id",
      "freeze_digest",
      "reviewed_at",
      "status",
      "attestation",
      "analysis_summary",
      "review_checklist",
      "evidence_examined_ids",
      "accepted_resolution_ids",
      "blocking_objections",
    ],
    [],
    "findings.final_review",
  );
  text(findings.final_review.reviewer_id, "findings.final_review.reviewer_id", {
    id: true,
  });
  text(findings.final_review.freeze_digest, "findings.final_review.freeze_digest", {
    sha: true,
  });
  timestamp(findings.final_review.reviewed_at, "findings.final_review.reviewed_at");
  enumValue(
    findings.final_review.status,
    ["ACCEPTED", "REQUEST_CHANGES"],
    "findings.final_review.status",
  );
  if (findings.final_review.attestation !== constants.final_review_attestation) {
    fail("findings.final_review.attestation", "expected the immutable final-review attestation");
  }
  text(findings.final_review.analysis_summary, "findings.final_review.analysis_summary");
  if (unicodeCodePointLength(findings.final_review.analysis_summary.trim()) < 80) {
    fail(
      "findings.final_review.analysis_summary",
      "must contain at least 80 substantive characters",
    );
  }
  uniqueStrings(findings.final_review.review_checklist, "findings.final_review.review_checklist", {
    id: true,
  });
  if (
    canonicalJson([...findings.final_review.review_checklist].sort()) !==
    canonicalJson([...constants.required_final_review_checks].sort())
  ) {
    fail(
      "findings.final_review.review_checklist",
      "must complete every required final-review check exactly once",
    );
  }
  uniqueStrings(
    findings.final_review.evidence_examined_ids,
    "findings.final_review.evidence_examined_ids",
    { id: true },
  );
  if (findings.final_review.evidence_examined_ids.length === 0) {
    fail("findings.final_review.evidence_examined_ids", "must identify frozen evidence");
  }
  uniqueStrings(
    findings.final_review.accepted_resolution_ids,
    "findings.final_review.accepted_resolution_ids",
    { id: true },
  );
  array(
    findings.final_review.blocking_objections,
    "findings.final_review.blocking_objections",
  ).forEach((value, index) => text(value, `findings.final_review.blocking_objections[${index}]`));
  return findings;
}

function thresholdPasses(gate, actual) {
  switch (gate.operator) {
    case "eq":
      return actual === gate.threshold;
    case "gte":
      return (
        typeof actual === "number" && typeof gate.threshold === "number" && actual >= gate.threshold
      );
    case "lte":
      return (
        typeof actual === "number" && typeof gate.threshold === "number" && actual <= gate.threshold
      );
    case "contains":
      return (
        typeof actual === "string" &&
        typeof gate.threshold === "string" &&
        actual.includes(gate.threshold)
      );
    case "manual_evidence":
      return actual === gate.threshold;
    default:
      return false;
  }
}

function processIssues(session, findings, evaluatedAt) {
  const issues = new Set(evidenceIssueCodes(session));
  const evidenceIds = new Set(session.evidence.map((item) => item.id));
  const expectedDigest = computeFreezeDigest(session);
  if (session.freeze_digest !== expectedDigest) {
    issues.add("EVIDENCE_DRIFT");
  }
  if (
    findings.session_id !== session.session_id ||
    findings.freeze_digest !== session.freeze_digest ||
    findings.final_review.freeze_digest !== session.freeze_digest
  ) {
    issues.add("EVIDENCE_DRIFT");
  }
  if (
    Date.parse(findings.cross_review_started_at) > Date.parse(findings.final_review.reviewed_at) ||
    Date.parse(findings.final_review.reviewed_at) > Date.parse(findings.decided_at) ||
    Date.parse(findings.decided_at) > Date.parse(evaluatedAt)
  ) {
    issues.add("PROCESS_INTEGRITY");
  }
  const requiredLenses = new Set(session.failure_lenses);
  const assignmentByLens = new Map(
    session.panel_assignments.map((assignment) => [
      assignment.lens_id,
      canonicalPrincipal(assignment.reviewer_id),
    ]),
  );
  const seenLenses = new Set();
  const seenReviewers = new Set();
  const reservedReviewers = new Set(
    [
      session.roles.builder_id,
      session.roles.evidence_writer_id,
      session.roles.executor_id,
      session.roles.final_reviewer_id,
      session.roles.decision_judge_id,
    ].map(canonicalPrincipal),
  );
  const requiredPanelEvidence = new Set([
    session.decision.candidate_evidence_id,
    ...session.proxy_charter.authority_evidence_ids,
    ...session.frozen_gates.flatMap((gate) => gate.required_evidence_ids),
    ...[
      session.decision.proposed_next_action,
      findings.proposed_repair_action,
      ...findings.gate_results.map((result) => result.repair_action),
    ]
      .filter((action) => action?.parameters.change_evidence_id != null)
      .map((action) => action.parameters.change_evidence_id),
  ]);
  for (const review of findings.reviews) {
    const reviewer = canonicalPrincipal(review.reviewer_id);
    if (seenReviewers.has(reviewer) || reservedReviewers.has(reviewer)) {
      issues.add("INDEPENDENCE_BREACH");
    }
    seenReviewers.add(reviewer);
    if (!session.failure_lenses.includes(review.lens_id)) {
      issues.add("REVIEW_INCOMPLETE");
    }
    if (assignmentByLens.get(review.lens_id) !== reviewer) {
      issues.add("INDEPENDENCE_BREACH");
    }
    if (requiredLenses.has(review.lens_id)) {
      if (seenLenses.has(review.lens_id)) {
        issues.add("INDEPENDENCE_BREACH");
      }
      seenLenses.add(review.lens_id);
    }
    if (review.freeze_digest !== session.freeze_digest) {
      issues.add("EVIDENCE_DRIFT");
    }
    if (review.evidence_examined_ids.some((id) => !evidenceIds.has(id))) {
      issues.add("MISSING_EVIDENCE");
    }
    if ([...requiredPanelEvidence].some((id) => !review.evidence_examined_ids.includes(id))) {
      issues.add("MISSING_EVIDENCE");
    }
    if (
      review.independence_attestation !== constants.independence_attestation ||
      review.saw_peer_findings_before_submission ||
      Date.parse(review.submitted_at) <= Date.parse(session.frozen_at) ||
      Date.parse(review.submitted_at) >= Date.parse(findings.cross_review_started_at)
    ) {
      issues.add("INDEPENDENCE_BREACH");
    }
    for (const observation of review.observations) {
      if (
        observation.classification === "fact" &&
        (observation.evidence_ids.length === 0 ||
          observation.evidence_ids.some(
            (id) => !evidenceIds.has(id) || !review.evidence_examined_ids.includes(id),
          ))
      ) {
        issues.add("MISSING_EVIDENCE");
      }
    }
    for (const objection of review.objections) {
      if (
        objection.severity !== "advisory" &&
        (objection.evidence_ids.length === 0 ||
          objection.evidence_ids.some(
            (id) => !evidenceIds.has(id) || !review.evidence_examined_ids.includes(id),
          ))
      ) {
        issues.add("MISSING_EVIDENCE");
      }
    }
    for (const contradiction of review.contradictions) {
      if (
        contradiction.severity === "material" &&
        (contradiction.evidence_ids.length === 0 ||
          contradiction.evidence_ids.some(
            (id) => !evidenceIds.has(id) || !review.evidence_examined_ids.includes(id),
          ))
      ) {
        issues.add("MISSING_EVIDENCE");
      }
    }
  }
  for (const lens of requiredLenses) {
    if (!seenLenses.has(lens)) {
      issues.add("REVIEW_INCOMPLETE");
    }
  }
  if (
    canonicalPrincipal(findings.final_review.reviewer_id) !==
      canonicalPrincipal(session.roles.final_reviewer_id) ||
    findings.final_review.status !== "ACCEPTED" ||
    findings.final_review.blocking_objections.length > 0
  ) {
    issues.add("REVIEW_INCOMPLETE");
  }
  if (findings.final_review.evidence_examined_ids.some((id) => !evidenceIds.has(id))) {
    issues.add("MISSING_EVIDENCE");
  }
  const requiredFinalEvidence = new Set([
    session.decision.candidate_evidence_id,
    ...session.proxy_charter.authority_evidence_ids,
    ...session.frozen_gates.flatMap((gate) => gate.required_evidence_ids),
    ...findings.reviews.flatMap((review) => review.evidence_examined_ids),
    ...[
      session.decision.proposed_next_action,
      findings.proposed_repair_action,
      ...findings.gate_results.map((result) => result.repair_action),
    ]
      .filter((action) => action?.parameters.change_evidence_id != null)
      .map((action) => action.parameters.change_evidence_id),
  ]);
  if (
    [...requiredFinalEvidence].some(
      (id) => !findings.final_review.evidence_examined_ids.includes(id),
    )
  ) {
    issues.add("MISSING_EVIDENCE");
  }
  if (
    canonicalPrincipal(findings.final_review.reviewer_id) ===
      canonicalPrincipal(session.roles.builder_id) ||
    canonicalPrincipal(findings.final_review.reviewer_id) ===
      canonicalPrincipal(session.roles.decision_judge_id)
  ) {
    issues.add("INDEPENDENCE_BREACH");
  }

  const gateById = new Map(session.frozen_gates.map((gate) => [gate.id, gate]));
  const seenGates = new Set();
  for (const result of findings.gate_results) {
    const gate = gateById.get(result.gate_id);
    if (!gate || seenGates.has(result.gate_id)) {
      issues.add("PROCESS_INTEGRITY");
      continue;
    }
    seenGates.add(result.gate_id);
    const missing = gate.required_evidence_ids.some(
      (id) => !result.evidence_ids.includes(id) || !evidenceIds.has(id),
    );
    if (
      missing ||
      result.status === "MISSING" ||
      result.evidence_ids.some((id) => !evidenceIds.has(id))
    ) {
      issues.add("MISSING_EVIDENCE");
    }
    if (
      (result.status === "PASS" && (result.correctable || result.repair_action !== null)) ||
      (result.status === "FAIL" && result.correctable !== (result.repair_action !== null)) ||
      (result.status === "MISSING" &&
        (result.correctable || result.repair_action !== null || result.observed_value !== null))
    ) {
      issues.add("PROCESS_INTEGRITY");
    }
    let observedValue = result.observed_value;
    if (gate.operator !== "manual_evidence" && result.status !== "MISSING") {
      try {
        observedValue = measurementValue(session, gate);
        if (canonicalJson(observedValue) !== canonicalJson(result.observed_value)) {
          issues.add("THRESHOLD_DRIFT");
        }
      } catch {
        issues.add("MISSING_EVIDENCE");
        observedValue = null;
      }
    }
    if (
      (gate.operator === "manual_evidence" &&
        (canonicalPrincipal(result.evaluator_id ?? "") !==
          canonicalPrincipal(session.roles.final_reviewer_id) ||
          result.evaluator_attestation !== constants.manual_gate_attestation)) ||
      (gate.operator !== "manual_evidence" &&
        (result.evaluator_id !== null || result.evaluator_attestation !== null))
    ) {
      issues.add("PROCESS_INTEGRITY");
    }
    if (
      (result.status === "PASS" && !thresholdPasses(gate, observedValue)) ||
      (result.status === "FAIL" && thresholdPasses(gate, observedValue))
    ) {
      issues.add("THRESHOLD_DRIFT");
    }
  }
  if (seenGates.size !== gateById.size) {
    issues.add("REVIEW_INCOMPLETE");
  }
  if (
    findings.challenge_rounds > session.max_challenge_rounds ||
    findings.challenges.some((challenge) => challenge.round > findings.challenge_rounds) ||
    (findings.challenge_rounds === 0 && findings.challenges.length > 0)
  ) {
    issues.add("PROCESS_INTEGRITY");
  }
  const findingById = new Map();
  for (const review of findings.reviews) {
    for (const [kind, finding] of [
      ...review.observations.map((item) => ["observation", item]),
      ...review.objections.map((item) => ["objection", item]),
      ...review.contradictions.map((item) => ["contradiction", item]),
    ]) {
      if (findingById.has(finding.id)) {
        issues.add("PROCESS_INTEGRITY");
      }
      findingById.set(finding.id, { kind, finding });
    }
  }
  const dispositions = new Map();
  const seenChallenges = new Set();
  const seenChallengeRounds = new Set();
  for (const challenge of [...findings.challenges].sort(
    (left, right) => left.round - right.round,
  )) {
    const challengeKey = `${challenge.round}\u0000${challenge.finding_id}`;
    if (seenChallenges.has(challengeKey)) {
      issues.add("PROCESS_INTEGRITY");
    }
    seenChallenges.add(challengeKey);
    seenChallengeRounds.add(challenge.round);
    const source = findingById.get(challenge.finding_id);
    if (source === undefined) {
      issues.add("PROCESS_INTEGRITY");
    }
    dispositions.set(challenge.finding_id, challenge.disposition);
    if (
      challenge.evidence_ids.length === 0 ||
      challenge.evidence_ids.some((id) => !evidenceIds.has(id))
    ) {
      issues.add("MISSING_EVIDENCE");
    }
    if (
      source !== undefined &&
      source.finding.evidence_ids.some((id) => !challenge.evidence_ids.includes(id))
    ) {
      issues.add("MISSING_EVIDENCE");
    }
    if (
      challenge.disposition === "resolved" &&
      source?.kind === "objection" &&
      constants.non_resolvable_challenge_codes.includes(source.finding.code)
    ) {
      issues.add("PROCESS_INTEGRITY");
    }
    if (challenge.disposition === "blocking") {
      issues.add("CHALLENGE_BLOCKING");
    }
  }
  for (let round = 1; round <= findings.challenge_rounds; round += 1) {
    if (!seenChallengeRounds.has(round)) {
      issues.add("PROCESS_INTEGRITY");
    }
  }
  const acceptedResolutionIds = [...new Set(findings.final_review.accepted_resolution_ids)].sort();
  const resolvedIds = [...dispositions]
    .filter(([, disposition]) => disposition === "resolved")
    .map(([id]) => id)
    .sort();
  if (canonicalJson(acceptedResolutionIds) !== canonicalJson(resolvedIds)) {
    issues.add("PROCESS_INTEGRITY");
  }
  const acceptedEvidenceIds = new Set(findings.final_review.evidence_examined_ids);
  for (const challenge of findings.challenges) {
    if (
      challenge.disposition === "resolved" &&
      challenge.evidence_ids.some((id) => !acceptedEvidenceIds.has(id))
    ) {
      issues.add("MISSING_EVIDENCE");
    }
  }
  const contradictionById = new Map(
    findings.reviews.flatMap((review) =>
      review.contradictions.map((contradiction) => [contradiction.id, contradiction]),
    ),
  );
  const unresolvedIds = new Set();
  for (const contradiction of findings.unresolved_contradictions) {
    if (unresolvedIds.has(contradiction.id)) {
      issues.add("PROCESS_INTEGRITY");
    }
    unresolvedIds.add(contradiction.id);
    const source = contradictionById.get(contradiction.id);
    if (
      source === undefined ||
      canonicalJson(source) !== canonicalJson(contradiction) ||
      dispositions.get(contradiction.id) === "resolved"
    ) {
      issues.add("PROCESS_INTEGRITY");
    }
  }
  for (const contradiction of contradictionById.values()) {
    if (
      contradiction.severity === "material" &&
      dispositions.get(contradiction.id) !== "resolved" &&
      !unresolvedIds.has(contradiction.id)
    ) {
      issues.add("PROCESS_INTEGRITY");
    }
  }
  if (
    findings.unresolved_contradictions.some(
      (contradiction) => contradiction.severity === "material",
    )
  ) {
    issues.add("UNRESOLVED_CONTRADICTION");
  }
  return [...issues].sort();
}

function collectObjections(findings) {
  const dispositions = new Map();
  for (const challenge of [...findings.challenges].sort(
    (left, right) => left.round - right.round,
  )) {
    dispositions.set(challenge.finding_id, challenge.disposition);
  }
  return findings.reviews.flatMap((review) =>
    review.objections.map((objection) => ({
      ...objection,
      reviewer_id: review.reviewer_id,
      disposition: dispositions.get(objection.id) ?? "retained",
    })),
  );
}

function uniqueRepairAction(findings) {
  const candidates = [
    findings.proposed_repair_action,
    ...findings.gate_results.map((result) => result.repair_action),
  ].filter((action) => action !== null);
  const unique = new Map(candidates.map((action) => [canonicalJson(action), action]));
  return {
    count: unique.size,
    action: unique.size === 1 ? [...unique.values()][0] : null,
  };
}

export function createDecisionRecord(session, findings) {
  const evaluatedAt = new Date().toISOString();
  timestamp(evaluatedAt, "decision.evaluatedAt");
  return deriveDecisionRecord(session, findings, evaluatedAt);
}

export function createFixtureDecisionRecord(session, findings, evaluatedAt) {
  timestamp(evaluatedAt, "fixture-decision.evaluatedAt");
  const inputDigest = digestJson({
    session,
    findings,
    evaluated_at: evaluatedAt,
  });
  if (!fixtureInputContract.digests.includes(inputDigest)) {
    fail(
      "fixture-decision",
      `deterministic clock input is not a canonical shipped fixture (${inputDigest})`,
    );
  }
  return deriveDecisionRecord(session, findings, evaluatedAt);
}

function deriveDecisionRecord(session, findings, evaluatedAt) {
  validateSession(session);
  validateFindings(findings);
  if (session.state !== "frozen") {
    fail("session.state", "decision requires a frozen session");
  }
  const proposedAuthority = actionAuthority(
    session,
    session.decision.proposed_next_action,
    evaluatedAt,
  );
  const process = processIssues(session, findings, evaluatedAt);
  const objections = collectObjections(findings);
  const escalationCodes = new Set(constants.escalation_issue_codes);
  const holdCodes = new Set(constants.hold_issue_codes);
  const objectionEscalations = objections
    .filter((item) => escalationCodes.has(item.code))
    .map((item) => item.code);
  const objectionHolds = objections
    .filter((item) => item.disposition !== "resolved" && holdCodes.has(item.code))
    .map((item) => item.code);
  const activeMaterialObjections = objections.filter(
    (item) => item.disposition !== "resolved" && item.severity === "material",
  );
  const repair = uniqueRepairAction(findings);
  const repairNeeded =
    findings.gate_results.some((result) => result.status === "FAIL" && result.correctable) ||
    activeMaterialObjections.some((item) => item.correctable) ||
    objections.some(
      (item) => item.disposition !== "resolved" && item.severity === "blocking" && item.correctable,
    );
  if (
    (repairNeeded && findings.proposed_repair_action === null) ||
    (!repairNeeded && repair.count > 0) ||
    (repair.action !== null && !constants.repair_action_categories.includes(repair.action.category))
  ) {
    process.push("PROCESS_INTEGRITY");
  }
  process.splice(0, process.length, ...new Set(process.sort()));
  const repairAuthority =
    repair.action === null ? null : actionAuthority(session, repair.action, evaluatedAt);

  let terminal;
  let reasonCodes;
  let authority = proposedAuthority;
  const authorityEscalates = !["WITHIN_DELEGATION", "MISSING_AUTHORITY"].includes(
    proposedAuthority.status,
  );
  const repairEscalates =
    repairAuthority !== null &&
    !["WITHIN_DELEGATION", "MISSING_AUTHORITY"].includes(repairAuthority.status);
  if (authorityEscalates || repairEscalates || objectionEscalations.length > 0) {
    terminal = "ESCALATE_TO_GLEN";
    authority = repairEscalates ? repairAuthority : proposedAuthority;
    reasonCodes = [...authority.issue_codes, ...objectionEscalations];
  } else if (
    proposedAuthority.status === "MISSING_AUTHORITY" ||
    repairAuthority?.status === "MISSING_AUTHORITY" ||
    process.length > 0 ||
    objectionHolds.length > 0 ||
    activeMaterialObjections.some((item) => !item.correctable) ||
    repair.count > 1
  ) {
    terminal = "HOLD";
    reasonCodes = [
      ...proposedAuthority.issue_codes,
      ...(repairAuthority?.issue_codes ?? []),
      ...process,
      ...objectionHolds,
      ...(activeMaterialObjections.some((item) => !item.correctable)
        ? ["UNRESOLVED_MATERIAL_OBJECTION"]
        : []),
      ...(repair.count > 1 ? ["PROCESS_INTEGRITY"] : []),
    ];
  } else {
    const uncorrectableGate = findings.gate_results.some(
      (result) => result.status === "FAIL" && !result.correctable,
    );
    const uncorrectableBlocker = objections.some(
      (item) =>
        item.disposition !== "resolved" && item.severity === "blocking" && !item.correctable,
    );
    const correctableGate = findings.gate_results.some(
      (result) => result.status === "FAIL" && result.correctable,
    );
    const correctableBlocker = objections.some(
      (item) => item.disposition !== "resolved" && item.severity === "blocking" && item.correctable,
    );
    const correctableMaterial = activeMaterialObjections.some((item) => item.correctable);
    if (uncorrectableGate || uncorrectableBlocker) {
      terminal = "ABORT_PATH";
      reasonCodes = ["UNCORRECTABLE_FAILURE"];
    } else if (correctableGate || correctableBlocker || correctableMaterial) {
      if (repair.count === 1 && repairAuthority?.status === "WITHIN_DELEGATION") {
        terminal = "REWORK_AND_CONTINUE";
        reasonCodes = ["CORRECTABLE_FAILURE"];
        authority = repairAuthority;
      } else {
        terminal = "HOLD";
        reasonCodes = [repair.count === 0 ? "MISSING_EVIDENCE" : "PROCESS_INTEGRITY"];
      }
    } else {
      const allPass =
        session.frozen_gates.length > 0 &&
        findings.gate_results.length === session.frozen_gates.length &&
        findings.gate_results.every((result) => result.status === "PASS");
      if (!allPass) {
        terminal = "HOLD";
        reasonCodes = ["REVIEW_INCOMPLETE"];
      } else {
        terminal = "PROCEED";
        reasonCodes = ["ALL_GATES_PASS"];
      }
    }
  }

  reasonCodes = [...new Set(reasonCodes)].sort();
  const nextAction =
    terminal === "PROCEED"
      ? structuredClone(session.decision.proposed_next_action)
      : terminal === "REWORK_AND_CONTINUE"
        ? structuredClone(repair.action)
        : null;
  const continuation =
    constants.continuation_decisions.includes(terminal) && nextAction?.category !== "no_action";
  const dissent = findings.reviews
    .map((review) => {
      const statements = [...review.dissent];
      if (review.recommendation !== terminal) {
        statements.push(`Reviewer recommendation: ${review.recommendation}`);
      }
      return { reviewer_id: review.reviewer_id, statements };
    })
    .filter((item) => item.statements.length > 0);
  const record = {
    schema_version: constants.decision_record_schema,
    algorithm_version: constants.algorithm_version,
    implementation_identity: structuredClone(implementationIdentity),
    record_id: "",
    session_id: session.session_id,
    mission_id: session.mission_id,
    decided_at: findings.decided_at,
    authority_verified_at: evaluatedAt,
    authorization_valid_until: session.proxy_charter.expires_at,
    freeze_digest: session.freeze_digest,
    frozen_session: structuredClone(session),
    findings: structuredClone(findings),
    authority_evaluation: authority,
    terminal_decision: terminal,
    reason_codes: reasonCodes,
    rationale: rationaleFor(terminal, reasonCodes),
    unresolved_contradictions: structuredClone(findings.unresolved_contradictions),
    dissent,
    next_authorized_action: nextAction,
    autonomous_continuation_allowed: continuation,
    execution_authority_granted: false,
    execution_authority_recheck_required: true,
    claim_ceiling_code: session.proxy_charter.claim_ceiling_code,
    claim_ceiling: session.proxy_charter.claim_ceiling,
    proof_bar: session.proxy_charter.proof_bar,
    claim_boundary:
      "This S.ADR records a bounded internal decision and point-in-time authority evidence; it is not an executable capability. Autonomous continuation means a separately enforcing mission runtime may perform only the exact action after recomputing live authority and consuming its single-use grant. This record does not authenticate a direct prompt or declared role identity; grant merge, release, production, credentials, remote-repository, external-effect, risk-acceptance, or mission-change authority; or remove the required action-boundary check.",
    integrity_digest: null,
  };
  record.record_id = `SADR:${digestJson({
    session_digest: digestJson(session),
    findings_digest: digestJson(findings),
    authority_verified_at: evaluatedAt,
    authority_evaluation: authority,
    terminal_decision: terminal,
    reason_codes: reasonCodes,
    next_authorized_action: nextAction,
    implementation_identity: record.implementation_identity,
  }).slice(0, 48)}`;
  record.integrity_digest = digestJson(record);
  return record;
}

function rationaleFor(terminal, codes) {
  const prefix = {
    ESCALATE_TO_GLEN: "The immutable charter or live delegation cannot authorize this decision.",
    HOLD: "Required evidence or process integrity is not complete.",
    ABORT_PATH: "The current path has an uncorrectable blocking failure.",
    REWORK_AND_CONTINUE: "One exact, delegated repair can address a correctable failure.",
    PROCEED: "All frozen gates pass and the exact next action remains delegated.",
  }[terminal];
  return `${prefix} Governing reason codes: ${codes.join(", ")}.`;
}

export function validateDecisionRecord(record) {
  const keys = [
    "schema_version",
    "algorithm_version",
    "implementation_identity",
    "record_id",
    "session_id",
    "mission_id",
    "decided_at",
    "authority_verified_at",
    "authorization_valid_until",
    "freeze_digest",
    "frozen_session",
    "findings",
    "authority_evaluation",
    "terminal_decision",
    "reason_codes",
    "rationale",
    "unresolved_contradictions",
    "dissent",
    "next_authorized_action",
    "autonomous_continuation_allowed",
    "execution_authority_granted",
    "execution_authority_recheck_required",
    "claim_ceiling_code",
    "claim_ceiling",
    "proof_bar",
    "claim_boundary",
    "integrity_digest",
  ];
  exactKeys(record, keys, [], "record");
  exactKeys(
    record.implementation_identity,
    [
      "engine_sha256",
      "json_utils_sha256",
      "skill_manifest_sha256",
      "fixture_input_contract_sha256",
    ],
    [],
    "record.implementation_identity",
  );
  for (const [key, expected] of Object.entries(implementationIdentity)) {
    text(record.implementation_identity[key], `record.implementation_identity.${key}`, {
      sha: true,
    });
    if (record.implementation_identity[key] !== expected) {
      fail(
        `record.implementation_identity.${key}`,
        "record was derived by a different implementation or inventory",
      );
    }
  }
  timestamp(record.decided_at, "record.decided_at");
  timestamp(record.authority_verified_at, "record.authority_verified_at");
  timestamp(record.authorization_valid_until, "record.authorization_valid_until");
  exactKeys(
    record.authority_evaluation,
    [
      "delegation_id",
      "action_digest",
      "evaluated_at",
      "authorization_valid_until",
      "status",
      "issue_codes",
      "explanation",
    ],
    [],
    "record.authority_evaluation",
  );
  text(record.authority_evaluation.delegation_id, "record.authority_evaluation.delegation_id", {
    id: true,
  });
  text(record.authority_evaluation.action_digest, "record.authority_evaluation.action_digest", {
    sha: true,
  });
  timestamp(record.authority_evaluation.evaluated_at, "record.authority_evaluation.evaluated_at");
  timestamp(
    record.authority_evaluation.authorization_valid_until,
    "record.authority_evaluation.authorization_valid_until",
  );
  enumValue(
    record.authority_evaluation.status,
    [
      "WITHIN_DELEGATION",
      "MISSING_AUTHORITY",
      "EXPIRED",
      "OUT_OF_SCOPE",
      "RESERVED",
      "UNKNOWN_CATEGORY",
      "CONFLICT",
    ],
    "record.authority_evaluation.status",
  );
  uniqueStrings(
    record.authority_evaluation.issue_codes,
    "record.authority_evaluation.issue_codes",
    { code: true },
  );
  text(record.authority_evaluation.explanation, "record.authority_evaluation.explanation");
  if (
    record.authority_evaluation.evaluated_at !== record.authority_verified_at ||
    record.authority_evaluation.authorization_valid_until !== record.authorization_valid_until
  ) {
    fail("record.authority_evaluation", "evaluation time metadata does not match the record");
  }
  if (record.execution_authority_recheck_required !== true) {
    fail("record.execution_authority_recheck_required", "must remain true");
  }
  if (record.execution_authority_granted !== false) {
    fail("record.execution_authority_granted", "a decision record cannot be a capability");
  }
  if (
    record.claim_ceiling_code !== constants.claim_ceiling_code ||
    record.claim_ceiling !== constants.claim_ceiling_text
  ) {
    fail("record.claim_ceiling", "immutable claim ceiling mismatch");
  }
  text(record.integrity_digest, "record.integrity_digest", { sha: true });
  const unhashed = structuredClone(record);
  unhashed.integrity_digest = null;
  if (digestJson(unhashed) !== record.integrity_digest) {
    fail("record.integrity_digest", "record bytes do not match digest");
  }
  const expected = deriveDecisionRecord(
    record.frozen_session,
    record.findings,
    record.authority_verified_at,
  );
  if (canonicalJson(expected) !== canonicalJson(record)) {
    fail("record", "terminal result or derived fields do not reproduce from embedded inputs");
  }
  return record;
}

export function recheckDecisionAuthority(record, currentSession) {
  validateDecisionRecord(record);
  validateSession(currentSession);
  const evaluatedAt = new Date().toISOString();
  const issues = new Set();
  const action = record.next_authorized_action;
  const prior = record.frozen_session;
  if (
    !record.autonomous_continuation_allowed ||
    !constants.continuation_decisions.includes(record.terminal_decision) ||
    action === null
  ) {
    issues.add("NO_AUTHORIZED_ACTION");
  }
  if (
    currentSession.state !== "frozen" ||
    currentSession.freeze_digest !== computeFreezeDigest(currentSession) ||
    Date.parse(currentSession.frozen_at) > Date.parse(evaluatedAt)
  ) {
    issues.add("EVIDENCE_DRIFT");
  }
  if (
    currentSession.mission_id !== record.mission_id ||
    currentSession.mission_statement !== prior.mission_statement ||
    canonicalJson(currentSession.decision) !== canonicalJson(prior.decision) ||
    currentSession.proxy_charter.target_scope.repository_id !==
      prior.proxy_charter.target_scope.repository_id ||
    currentSession.proxy_charter.target_scope.workspace_id !==
      prior.proxy_charter.target_scope.workspace_id
  ) {
    issues.add("AUTHORITY_CONFLICT");
  }
  if (
    canonicalJson(currentSession.suitability) !== canonicalJson(prior.suitability) ||
    canonicalJson(currentSession.failure_lenses) !== canonicalJson(prior.failure_lenses) ||
    canonicalJson(currentSession.frozen_gates) !== canonicalJson(prior.frozen_gates) ||
    canonicalJson(currentSession.panel_assignments) !== canonicalJson(prior.panel_assignments) ||
    canonicalJson(currentSession.roles) !== canonicalJson(prior.roles) ||
    currentSession.max_challenge_rounds !== prior.max_challenge_rounds
  ) {
    issues.add("EVIDENCE_DRIFT");
  }
  const authorityMutableFields = new Set([
    "expires_at",
    "authorization_nonce",
    "revoked",
    "stop_condition_active",
  ]);
  const stableCharter = (session) =>
    Object.fromEntries(
      Object.entries(session.proxy_charter).filter(([key]) => !authorityMutableFields.has(key)),
    );
  if (canonicalJson(stableCharter(currentSession)) !== canonicalJson(stableCharter(prior))) {
    issues.add("AUTHORITY_CONFLICT");
  }
  const nonAuthorityEvidence = (session) =>
    session.evidence
      .filter((item) => item.classification !== "authority")
      .sort((left, right) => left.id.localeCompare(right.id));
  if (
    canonicalJson(nonAuthorityEvidence(currentSession)) !==
    canonicalJson(nonAuthorityEvidence(prior))
  ) {
    issues.add("EVIDENCE_DRIFT");
  }
  for (const code of evidenceIssueCodes(currentSession)) {
    issues.add(code);
  }
  const authority = action === null ? null : actionAuthority(currentSession, action, evaluatedAt);
  for (const code of authority?.issue_codes ?? []) {
    issues.add(code);
  }
  const authorized = issues.size === 0 && authority?.status === "WITHIN_DELEGATION";
  const recheckValidUntil = new Date(
    Math.min(
      Date.parse(currentSession.proxy_charter.expires_at),
      Date.parse(evaluatedAt) + constants.authority_recheck_ttl_seconds * 1000,
    ),
  ).toISOString();
  const result = {
    schema_version: constants.authority_recheck_schema,
    record_id: record.record_id,
    record_integrity_digest: record.integrity_digest,
    implementation_identity: structuredClone(record.implementation_identity),
    current_session_id: currentSession.session_id,
    current_freeze_digest: currentSession.freeze_digest,
    decision_context_digest: currentSession.proxy_charter.decision_context_digest,
    proof_plan_digest: currentSession.proxy_charter.proof_plan_digest,
    delegation_id: currentSession.proxy_charter.delegation_id,
    evaluated_at: evaluatedAt,
    recheck_valid_until: recheckValidUntil,
    action_digest: action === null ? null : digestJson(action),
    target_scope: structuredClone(currentSession.proxy_charter.target_scope),
    authorization_nonce: currentSession.proxy_charter.authorization_nonce,
    authorization_use_limit: currentSession.proxy_charter.authorization_use_limit,
    nonce_consumption_required: true,
    execution_authority_granted: false,
    authorized,
    authority_status: authority?.status ?? "NOT_APPLICABLE",
    reason_codes: [...issues].sort(),
    authorization_valid_until: currentSession.proxy_charter.expires_at,
    claim_boundary:
      "This short-lived record-bound result is current delegation evidence, not an executable capability or reusable authorization receipt. Continuation requires a separately enforcing mission executor to recompute the check at the action boundary and atomically consume the named single-use nonce. It grants no other execution, remote, merge, release, production, credential, external-effect, risk-acceptance, or mission-change authority.",
    integrity_digest: null,
  };
  result.integrity_digest = digestJson(result);
  return result;
}

function escapeMarkdownText(value) {
  const normalized = String(value)
    .replace(/[\r\n\t\u2028\u2029]+/gu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "\ufffd")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "\ufffd")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const markdownSyntax = new Set("\\`*_{}[]()#+-.!|~".split(""));
  return [...normalized]
    .map((character) => {
      if (character === ":") {
        // Prevent rendered evidence metadata from becoming an implicit remote URL.
        return "&#58;";
      }
      return markdownSyntax.has(character) ? `\\${character}` : character;
    })
    .join("");
}

function markdownValue(value) {
  if (value === null || value === undefined) {
    return "None.";
  }
  return escapeMarkdownText(value);
}

function markdownValues(values) {
  return values.length === 0 ? "None." : values.map(escapeMarkdownText).join(", ");
}

function markdownList(values, render) {
  return values.length === 0
    ? "- None recorded."
    : values.map((value, index) => `- ${render(value, index)}`).join("\n");
}

function markdownAction(action) {
  if (action === null) {
    return "No action is authorized by this record.";
  }
  return [
    `- Operation ID: ${escapeMarkdownText(action.operation_id)}`,
    `- Target scope ID: ${escapeMarkdownText(action.target_scope_id)}`,
    `- Description: ${escapeMarkdownText(action.description)}`,
    `- Category: ${escapeMarkdownText(action.category)}`,
    `- Destination: ${escapeMarkdownText(action.destination)}`,
    `- Declared effects: ${markdownValues(action.declared_effects)}`,
    `- Reversible: ${action.reversible ? "yes" : "no"}`,
    `- Immutable operation parameters: ${escapeMarkdownText(canonicalJson(action.parameters))}`,
  ].join("\n");
}

export function renderDecisionMarkdown(record) {
  validateDecisionRecord(record);
  const session = record.frozen_session;
  const findings = record.findings;
  const gateResultById = new Map(findings.gate_results.map((result) => [result.gate_id, result]));
  const challengeDispositionById = new Map(
    [...findings.challenges]
      .sort((left, right) => left.round - right.round)
      .map((challenge) => [challenge.finding_id, challenge.disposition]),
  );
  const objections = collectObjections(findings);

  const options = markdownList(
    session.decision.options,
    (option) => `${escapeMarkdownText(option.id)}: ${escapeMarkdownText(option.summary)}`,
  );
  const contractIdentity = markdownList(
    Object.entries(session.contract_identity),
    ([key, value]) => `${escapeMarkdownText(key)}: ${markdownValue(value)}`,
  );
  const roles = markdownList(
    Object.entries(session.roles),
    ([role, principal]) => `${escapeMarkdownText(role)}: ${escapeMarkdownText(principal)}`,
  );
  const panelAssignments = markdownList(
    session.panel_assignments,
    (assignment) =>
      `${escapeMarkdownText(assignment.lens_id)}: ${escapeMarkdownText(assignment.reviewer_id)}`,
  );
  const evidence = markdownList(session.evidence, (item) =>
    [
      `${escapeMarkdownText(item.id)}`,
      `  - Kind: ${escapeMarkdownText(item.kind)}`,
      `  - Classification: ${escapeMarkdownText(item.classification)}`,
      `  - Source: ${escapeMarkdownText(item.source)}`,
      `  - Encoding: ${escapeMarkdownText(item.encoding)}`,
      `  - SHA-256: ${escapeMarkdownText(item.sha256)}`,
      `  - Untrusted input: ${item.untrusted ? "yes" : "no"}`,
    ].join("\n"),
  );
  const gates = session.frozen_gates
    .map((gate) => {
      const result = gateResultById.get(gate.id);
      const resultLines =
        result === undefined
          ? ["- Result status: No result recorded."]
          : [
              `- Result status: ${escapeMarkdownText(result.status)}`,
              `- Observed value: ${markdownValue(result.observed_value)}`,
              `- Result evidence: ${markdownValues(result.evidence_ids)}`,
              `- Result explanation: ${escapeMarkdownText(result.explanation)}`,
              `- Correctable: ${result.correctable ? "yes" : "no"}`,
              ...(result.repair_action === null
                ? ["- Repair action: None."]
                : [
                    "- Repair action:",
                    `  - Operation ID: ${escapeMarkdownText(result.repair_action.operation_id)}`,
                    `  - Target scope ID: ${escapeMarkdownText(
                      result.repair_action.target_scope_id,
                    )}`,
                    `  - Description: ${escapeMarkdownText(result.repair_action.description)}`,
                    `  - Category: ${escapeMarkdownText(result.repair_action.category)}`,
                    `  - Destination: ${escapeMarkdownText(result.repair_action.destination)}`,
                    `  - Declared effects: ${markdownValues(
                      result.repair_action.declared_effects,
                    )}`,
                    `  - Reversible: ${result.repair_action.reversible ? "yes" : "no"}`,
                    `  - Immutable operation parameters: ${escapeMarkdownText(
                      canonicalJson(result.repair_action.parameters),
                    )}`,
                  ]),
              `- Evaluator ID: ${markdownValue(result.evaluator_id)}`,
              `- Evaluator attestation: ${markdownValue(result.evaluator_attestation)}`,
            ];
      return [
        `### Gate ${escapeMarkdownText(gate.id)}`,
        "",
        `- Criterion: ${escapeMarkdownText(gate.criterion)}`,
        `- Measure: ${escapeMarkdownText(gate.measure)}`,
        `- Frozen comparison: ${escapeMarkdownText(gate.operator)} ${markdownValue(gate.threshold)}`,
        `- Measurement command ID: ${markdownValue(gate.measurement_command_id)}`,
        `- Measurement arguments: ${markdownValues(gate.measurement_arguments)}`,
        `- Required exit code: ${markdownValue(gate.required_exit_code)}`,
        `- Pass condition: ${escapeMarkdownText(gate.pass_condition)}`,
        `- Required evidence: ${markdownValues(gate.required_evidence_ids)}`,
        ...resultLines,
      ].join("\n");
    })
    .join("\n\n");
  const reviews = findings.reviews
    .map((review) => {
      const classifications = ["fact", "assumption", "interpretation", "preference"]
        .map((classification) => {
          const observations = review.observations.filter(
            (observation) => observation.classification === classification,
          );
          return [
            `#### ${classification[0].toUpperCase()}${classification.slice(1)} findings`,
            "",
            markdownList(
              observations,
              (observation) =>
                `${escapeMarkdownText(observation.id)}: ${escapeMarkdownText(
                  observation.statement,
                )} Evidence: ${markdownValues(observation.evidence_ids)}`,
            ),
          ].join("\n");
        })
        .join("\n\n");
      const contradictions = markdownList(
        review.contradictions,
        (contradiction) =>
          `${escapeMarkdownText(contradiction.id)} (${escapeMarkdownText(
            contradiction.severity,
          )}; disposition: ${escapeMarkdownText(
            challengeDispositionById.get(contradiction.id) ?? "unresolved",
          )}): ${escapeMarkdownText(contradiction.statement)} Evidence: ${markdownValues(
            contradiction.evidence_ids,
          )}`,
      );
      return [
        `### Reviewer ${escapeMarkdownText(review.reviewer_id)}`,
        "",
        `- Failure lens: ${escapeMarkdownText(review.lens_id)}`,
        `- Submitted at: ${escapeMarkdownText(review.submitted_at)}`,
        `- Freeze digest: ${escapeMarkdownText(review.freeze_digest)}`,
        `- Peer findings seen before submission: ${
          review.saw_peer_findings_before_submission ? "yes" : "no"
        }`,
        `- Independence attestation: ${escapeMarkdownText(review.independence_attestation)}`,
        `- Evidence examined: ${markdownValues(review.evidence_examined_ids)}`,
        `- Review checklist: ${markdownValues(review.review_checklist)}`,
        `- Recommendation: ${escapeMarkdownText(review.recommendation)}`,
        `- Analysis summary: ${escapeMarkdownText(review.analysis_summary)}`,
        "",
        classifications,
        "",
        "#### Reviewer contradictions",
        "",
        contradictions,
        "",
        "#### Uncertainty",
        "",
        markdownList(review.uncertainty, escapeMarkdownText),
        "",
        "#### Falsifiers",
        "",
        markdownList(review.falsifiers, escapeMarkdownText),
        "",
        "#### Reviewer dissent",
        "",
        markdownList(review.dissent, escapeMarkdownText),
      ].join("\n");
    })
    .join("\n\n");
  const objectionRecord = markdownList(objections, (objection) =>
    [
      `${escapeMarkdownText(objection.id)} (${escapeMarkdownText(
        objection.code,
      )}; severity: ${escapeMarkdownText(objection.severity)}; disposition: ${escapeMarkdownText(
        objection.disposition,
      )}; correctable: ${objection.correctable ? "yes" : "no"})`,
      `  - Reviewer: ${escapeMarkdownText(objection.reviewer_id)}`,
      `  - Statement: ${escapeMarkdownText(objection.statement)}`,
      `  - Evidence: ${markdownValues(objection.evidence_ids)}`,
    ].join("\n"),
  );
  const challenges = markdownList(findings.challenges, (challenge) =>
    [
      `Round ${challenge.round}; finding ${escapeMarkdownText(
        challenge.finding_id,
      )}; disposition ${escapeMarkdownText(challenge.disposition)}`,
      `  - Challenge: ${escapeMarkdownText(challenge.challenge)}`,
      `  - Evidence: ${markdownValues(challenge.evidence_ids)}`,
    ].join("\n"),
  );
  const allContradictions = findings.reviews.flatMap((review) =>
    review.contradictions.map((contradiction) => ({
      ...contradiction,
      reviewer_id: review.reviewer_id,
      disposition: challengeDispositionById.get(contradiction.id) ?? "unresolved",
    })),
  );
  const contradictionRecord = markdownList(
    allContradictions,
    (contradiction) =>
      `${escapeMarkdownText(contradiction.id)} (reviewer: ${escapeMarkdownText(
        contradiction.reviewer_id,
      )}; severity: ${escapeMarkdownText(
        contradiction.severity,
      )}; disposition: ${escapeMarkdownText(
        contradiction.disposition,
      )}): ${escapeMarkdownText(contradiction.statement)} Evidence: ${markdownValues(
        contradiction.evidence_ids,
      )}`,
  );
  const unresolvedContradictions = markdownList(
    record.unresolved_contradictions,
    (contradiction) =>
      `${escapeMarkdownText(contradiction.id)} (${escapeMarkdownText(
        contradiction.severity,
      )}): ${escapeMarkdownText(contradiction.statement)} Evidence: ${markdownValues(
        contradiction.evidence_ids,
      )}`,
  );
  const dissent = markdownList(
    record.dissent,
    (item) =>
      `${escapeMarkdownText(item.reviewer_id)}: ${item.statements
        .map(escapeMarkdownText)
        .join(" | ")}`,
  );
  const finalReview = findings.final_review;

  return `# Scoped Architecture Decision Record

## Outcome

- Record: ${escapeMarkdownText(record.record_id)}
- Mission: ${escapeMarkdownText(record.mission_id)}
- Session: ${escapeMarkdownText(record.session_id)}
- Terminal decision: **${escapeMarkdownText(record.terminal_decision)}**
- Reason codes: ${markdownValues(record.reason_codes)}
- Decided at: ${escapeMarkdownText(record.decided_at)}
- Authority verified at: ${escapeMarkdownText(record.authority_verified_at)}
- Authorization valid until: ${markdownValue(record.authorization_valid_until)}
- Autonomous continuation: **${record.autonomous_continuation_allowed ? "allowed" : "prohibited"}**
- Execution authority granted by this record: **no**
- Execution-time authority recheck required: ${
    record.execution_authority_recheck_required ? "yes" : "no"
  }
- Rationale: ${escapeMarkdownText(record.rationale)}

## Scope and frozen question

- Mission statement: ${escapeMarkdownText(session.mission_statement)}
- Exact question: ${escapeMarkdownText(session.decision.question)}
- Candidate evidence ID: ${escapeMarkdownText(session.decision.candidate_evidence_id)}
- Candidate digest: ${escapeMarkdownText(session.decision.candidate_digest)}
- Frozen at: ${escapeMarkdownText(session.frozen_at)}
- Freeze digest: ${escapeMarkdownText(record.freeze_digest)}
- Maximum challenge rounds: ${session.max_challenge_rounds}

### Options

${options}

### Proposed action at freeze

${markdownAction(session.decision.proposed_next_action)}

### Contract identity

${contractIdentity}

## Authority and claim boundary

- Delegation: ${escapeMarkdownText(record.authority_evaluation.delegation_id)}
- Granted by: ${escapeMarkdownText(session.proxy_charter.granted_by)}
- Decision owner: ${escapeMarkdownText(session.proxy_charter.decision_owner)}
- Authority status: ${escapeMarkdownText(record.authority_evaluation.status)}
- Authority issue codes: ${markdownValues(record.authority_evaluation.issue_codes)}
- Authority explanation: ${escapeMarkdownText(record.authority_evaluation.explanation)}
- Evaluated action digest: ${escapeMarkdownText(record.authority_evaluation.action_digest)}
- Evaluation time: ${escapeMarkdownText(record.authority_evaluation.evaluated_at)}
- Evaluation valid until: ${markdownValue(record.authority_evaluation.authorization_valid_until)}
- Delegated scope: ${escapeMarkdownText(session.proxy_charter.scope)}
- Delegated mission: ${escapeMarkdownText(session.proxy_charter.mission_id)}
- Decision context digest: ${escapeMarkdownText(session.proxy_charter.decision_context_digest)}
- Proof plan digest: ${escapeMarkdownText(session.proxy_charter.proof_plan_digest)}
- Proof plan committed at: ${escapeMarkdownText(session.proxy_charter.proof_plan_committed_at)}
- Target scope kind: ${escapeMarkdownText(session.proxy_charter.target_scope.kind)}
- Target repository: ${escapeMarkdownText(session.proxy_charter.target_scope.repository_id)}
- Target workspace: ${escapeMarkdownText(session.proxy_charter.target_scope.workspace_id)}
- Allowed action categories: ${markdownValues(session.proxy_charter.allowed_action_categories)}
- Authorized action digests: ${markdownValues(session.proxy_charter.authorized_action_digests)}
- Network policy: ${escapeMarkdownText(session.proxy_charter.network_policy)}
- Authority evidence IDs: ${markdownValues(session.proxy_charter.authority_evidence_ids)}
- Custody method: ${escapeMarkdownText(session.proxy_charter.authority_custody.method)}
- Custody verifier: ${escapeMarkdownText(session.proxy_charter.authority_custody.verifier_id)}
- Custody evidence: ${escapeMarkdownText(session.proxy_charter.authority_custody.evidence_id)}
- Custody attestation: ${escapeMarkdownText(session.proxy_charter.authority_custody.attestation)}
- Boundary kind: ${escapeMarkdownText(session.proxy_charter.boundary_kind)}
- Expiration: ${markdownValue(session.proxy_charter.expires_at)}
- Authorization nonce: ${escapeMarkdownText(session.proxy_charter.authorization_nonce)}
- Authorization use limit: ${session.proxy_charter.authorization_use_limit}
- Mission boundary: ${escapeMarkdownText(session.proxy_charter.mission_boundary)}
- Mission-reserved categories: ${markdownValues(
    session.proxy_charter.mission_reserved_action_categories,
  )}
- Revoked: ${session.proxy_charter.revoked ? "yes" : "no"}
- Stop condition active: ${session.proxy_charter.stop_condition_active ? "yes" : "no"}
- Claim ceiling code: ${escapeMarkdownText(record.claim_ceiling_code)}
- Claim ceiling: ${escapeMarkdownText(record.claim_ceiling)}
- Proof bar: ${escapeMarkdownText(record.proof_bar)}
- Claim boundary: ${escapeMarkdownText(record.claim_boundary)}

## Roles and review custody

${roles}

### Frozen panel assignments

${panelAssignments}

## Frozen evidence metadata

Raw evidence content is intentionally omitted. Metadata and content hashes are retained below.

${evidence}

## Frozen gates and results

${gates}

## Independent reviewer findings

${reviews}

## Objections and derived dispositions

${objectionRecord}

## Challenges and repair

- Challenge rounds used: ${findings.challenge_rounds}

${challenges}

### Proposed repair action

${markdownAction(findings.proposed_repair_action)}

## Contradictions and dissent

### All reviewer contradictions

${contradictionRecord}

### Unresolved contradictions

${unresolvedContradictions}

### Preserved dissent and materially different recommendations

${dissent}

## Final independent review

- Reviewer: ${escapeMarkdownText(finalReview.reviewer_id)}
- Reviewed at: ${escapeMarkdownText(finalReview.reviewed_at)}
- Status: ${escapeMarkdownText(finalReview.status)}
- Freeze digest: ${escapeMarkdownText(finalReview.freeze_digest)}
- Attestation: ${escapeMarkdownText(finalReview.attestation)}
- Analysis summary: ${escapeMarkdownText(finalReview.analysis_summary)}
- Review checklist: ${markdownValues(finalReview.review_checklist)}
- Evidence examined: ${markdownValues(finalReview.evidence_examined_ids)}
- Accepted resolution IDs: ${markdownValues(finalReview.accepted_resolution_ids)}
- Blocking objections: ${markdownValues(finalReview.blocking_objections)}

## Next authorized action

${markdownAction(record.next_authorized_action)}

Autonomous continuation is **${
    record.autonomous_continuation_allowed ? "allowed" : "prohibited"
  }** only for the exact action above.

## Integrity

- Schema: ${escapeMarkdownText(record.schema_version)}
- Algorithm: ${escapeMarkdownText(record.algorithm_version)}
- Engine SHA-256: ${escapeMarkdownText(record.implementation_identity.engine_sha256)}
- JSON utility SHA-256: ${escapeMarkdownText(record.implementation_identity.json_utils_sha256)}
- Skill manifest SHA-256: ${escapeMarkdownText(
    record.implementation_identity.skill_manifest_sha256,
  )}
- Fixture input contract SHA-256: ${escapeMarkdownText(
    record.implementation_identity.fixture_input_contract_sha256,
  )}
- Freeze digest: ${escapeMarkdownText(record.freeze_digest)}
- JSON integrity digest: ${escapeMarkdownText(record.integrity_digest)}
`;
}

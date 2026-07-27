import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTRACT_VERSION = 1;
const SUITE_ID = "openclaw-standard-hosting-profiles";
const READINESS_REF = /^[a-z0-9][a-z0-9._/-]*$/u;
const READINESS_KIND = /^[a-z0-9][a-z0-9._-]*$/u;
const READINESS_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const READINESS_REASON = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const VALIDATION_FINDING_REASONS = new Set([
  "GatewayReadinessUnavailable",
  "ReadinessResultInvalid",
  "ReadinessContractMismatch",
  "HostingProfileNotSelected",
  "HostingProfileMismatch",
  "HostingProfileContractMismatch",
  "HostingProfileUnknown",
  "HostingProfileConditionMissing",
  "HostingProfileConditionDuplicate",
  "HostingProfileConditionNotRequired",
]);
const EXPECTED_SCENARIOS = [
  "unprofiled",
  "local",
  "local-restarted",
  "container-ready",
  "container-loopback",
  "reverse-proxy-ready",
  "reverse-proxy-auth-missing",
  "node-not-ready",
  "node-unapproved",
  "node-ready",
  "workspace-ready",
  "workspace-full",
  "workspace-recovered",
];

function usage() {
  return [
    "usage:",
    "  hosting-profiles-conformance.mjs init <artifact> <package-version> <image-reference> <image-id> [package-sha256]",
    "  hosting-profiles-conformance.mjs record <artifact> <scenario> <profile|-> <conformant> <ready> <exit-code>",
    "  hosting-profiles-conformance.mjs finalize <artifact>",
  ].join("\n");
}

function parseBoolean(value, label) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${label} must be true or false`);
}

function parseExitCode(value) {
  if (!/^\d+$/u.test(value ?? "")) {
    throw new Error("exit code must be a non-negative integer");
  }
  return Number(value);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function summarize(scenarios) {
  const passed = scenarios.filter((scenario) => scenario.passed).length;
  return {
    total: scenarios.length,
    passed,
    failed: scenarios.length - passed,
  };
}

function validateArtifact(artifact) {
  if (
    artifact?.contractVersion !== CONTRACT_VERSION ||
    artifact?.suite !== SUITE_ID ||
    artifact?.profileContractVersion !== CONTRACT_VERSION ||
    artifact?.package?.name !== "openclaw" ||
    typeof artifact?.package?.version !== "string" ||
    artifact.package.version.length === 0 ||
    typeof artifact?.image?.reference !== "string" ||
    artifact.image.reference.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact?.image?.id ?? "") ||
    !Array.isArray(artifact?.scenarios)
  ) {
    throw new Error("invalid hosting profile conformance artifact");
  }
}

function isBoundedString(value, pattern, maximumLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    pattern.test(value)
  );
}

function isReadinessSubject(subject) {
  return (
    typeof subject === "object" &&
    subject !== null &&
    !Array.isArray(subject) &&
    isBoundedString(subject.ref, READINESS_REF, 192) &&
    isBoundedString(subject.kind, READINESS_KIND, 128) &&
    (subject.id === undefined || isBoundedString(subject.id, READINESS_IDENTITY, 128)) &&
    (subject.generation === undefined ||
      isBoundedString(subject.generation, READINESS_IDENTITY, 128)) &&
    (subject.parentRef === undefined || isBoundedString(subject.parentRef, READINESS_REF, 192))
  );
}

function isReadinessCondition(condition) {
  return (
    typeof condition === "object" &&
    condition !== null &&
    !Array.isArray(condition) &&
    isBoundedString(condition.type, READINESS_REASON, 128) &&
    isBoundedString(condition.subjectRef, READINESS_REF, 192) &&
    (condition.relatedSubjectRefs === undefined ||
      (Array.isArray(condition.relatedSubjectRefs) &&
        condition.relatedSubjectRefs.length <= 16 &&
        condition.relatedSubjectRefs.every((ref) => isBoundedString(ref, READINESS_REF, 192)))) &&
    (condition.observedAtMs === undefined ||
      (Number.isInteger(condition.observedAtMs) && condition.observedAtMs >= 0)) &&
    ["True", "False", "Unknown"].includes(condition.status) &&
    ["required", "advisory"].includes(condition.requirement) &&
    isBoundedString(condition.reason, READINESS_REASON, 128) &&
    typeof condition.message === "string" &&
    condition.message.length <= 512
  );
}

function isCanonicalReadinessResult(readiness) {
  const reasonList = (value) =>
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((reason) => isBoundedString(reason, READINESS_REASON, 128));
  return (
    typeof readiness === "object" &&
    readiness !== null &&
    !Array.isArray(readiness) &&
    readiness.contractVersion === CONTRACT_VERSION &&
    Number.isInteger(readiness.evaluatedAtMs) &&
    readiness.evaluatedAtMs >= 0 &&
    typeof readiness.identity === "object" &&
    readiness.identity !== null &&
    !Array.isArray(readiness.identity) &&
    isBoundedString(readiness.identity.producerRef, READINESS_REF, 192) &&
    Array.isArray(readiness.identity.subjects) &&
    readiness.identity.subjects.length <= 128 &&
    readiness.identity.subjects.every(isReadinessSubject) &&
    typeof readiness.ready === "boolean" &&
    Array.isArray(readiness.conditions) &&
    readiness.conditions.length <= 256 &&
    readiness.conditions.every(isReadinessCondition) &&
    reasonList(readiness.failures) &&
    reasonList(readiness.advisories)
  );
}

function isValidationFinding(finding) {
  return (
    typeof finding === "object" &&
    finding !== null &&
    !Array.isArray(finding) &&
    Object.keys(finding).every((key) => key === "reason" || key === "message") &&
    VALIDATION_FINDING_REASONS.has(finding.reason) &&
    typeof finding.message === "string" &&
    finding.message.length > 0
  );
}

function validateValidationResult(validation) {
  const findings = validation?.findings;
  if (
    validation?.contractVersion !== CONTRACT_VERSION ||
    typeof validation?.conformant !== "boolean" ||
    typeof validation?.ready !== "boolean" ||
    !Array.isArray(findings) ||
    !findings.every(isValidationFinding) ||
    validation.conformant !== (findings.length === 0) ||
    !isCanonicalReadinessResult(validation?.readiness) ||
    validation.ready !== validation.readiness.ready
  ) {
    throw new Error("invalid hosting profile validation result");
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("missing hosting profile validation JSON on stdin");
  }
  return JSON.parse(text);
}

async function initArtifact(filePath, packageVersion, imageReference, imageId, packageSha256) {
  if (!packageVersion || !imageReference || !/^sha256:[a-f0-9]{64}$/u.test(imageId ?? "")) {
    throw new Error("package version, image reference, and immutable image ID are required");
  }
  if (packageSha256 && !/^[a-f0-9]{64}$/u.test(packageSha256)) {
    throw new Error("package SHA-256 must contain 64 lowercase hexadecimal characters");
  }
  const artifact = {
    contractVersion: CONTRACT_VERSION,
    suite: SUITE_ID,
    profileContractVersion: CONTRACT_VERSION,
    package: {
      name: "openclaw",
      version: packageVersion,
      ...(packageSha256 ? { sha256: packageSha256 } : {}),
    },
    image: {
      reference: imageReference,
      id: imageId,
    },
    scenarios: [],
    summary: summarize([]),
    passed: false,
  };
  await writeJsonAtomic(filePath, artifact);
}

async function recordScenario(
  filePath,
  scenarioId,
  profileArg,
  expectedConformantArg,
  expectedReadyArg,
  exitCodeArg,
) {
  if (!EXPECTED_SCENARIOS.includes(scenarioId)) {
    throw new Error(`unknown hosting profile conformance scenario: ${scenarioId}`);
  }
  const expectedProfile = profileArg === "-" ? undefined : profileArg;
  const expectedConformant = parseBoolean(expectedConformantArg, "expected conformant");
  const expectedReady = parseBoolean(expectedReadyArg, "expected ready");
  const exitCode = parseExitCode(exitCodeArg);
  const expectedExitCode = expectedConformant && expectedReady ? 0 : 1;
  const validation = await readStdin();
  validateValidationResult(validation);

  const mismatches = [];
  if (validation.conformant !== expectedConformant) {
    mismatches.push(`conformant=${validation.conformant}; expected ${expectedConformant}`);
  }
  if (validation.ready !== expectedReady) {
    mismatches.push(`ready=${validation.ready}; expected ${expectedReady}`);
  }
  if (validation.expectedProfile !== expectedProfile) {
    mismatches.push(
      `expectedProfile=${JSON.stringify(validation.expectedProfile)}; expected ${JSON.stringify(expectedProfile)}`,
    );
  }
  if (validation.activeProfile !== expectedProfile) {
    mismatches.push(
      `activeProfile=${JSON.stringify(validation.activeProfile)}; expected ${JSON.stringify(expectedProfile)}`,
    );
  }
  if (exitCode !== expectedExitCode) {
    mismatches.push(`exitCode=${exitCode}; expected ${expectedExitCode}`);
  }

  const artifact = await readJson(filePath);
  validateArtifact(artifact);
  if (artifact.scenarios.some((scenario) => scenario.id === scenarioId)) {
    throw new Error(`duplicate hosting profile conformance scenario: ${scenarioId}`);
  }
  artifact.scenarios.push({
    id: scenarioId,
    expected: {
      ...(expectedProfile ? { profile: expectedProfile } : {}),
      conformant: expectedConformant,
      ready: expectedReady,
      exitCode: expectedExitCode,
    },
    observed: {
      exitCode,
      validation,
    },
    passed: mismatches.length === 0,
    ...(mismatches.length > 0 ? { mismatches } : {}),
  });
  artifact.summary = summarize(artifact.scenarios);
  artifact.passed = false;
  await writeJsonAtomic(filePath, artifact);
  if (mismatches.length > 0) {
    throw new Error(`${scenarioId} conformance mismatch: ${mismatches.join("; ")}`);
  }
}

async function finalizeArtifact(filePath) {
  const artifact = await readJson(filePath);
  validateArtifact(artifact);
  const actualScenarioIds = artifact.scenarios.map((scenario) => scenario.id);
  const missing = EXPECTED_SCENARIOS.filter((scenario) => !actualScenarioIds.includes(scenario));
  const unexpected = actualScenarioIds.filter((scenario) => !EXPECTED_SCENARIOS.includes(scenario));
  const failed = artifact.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => scenario.id);
  if (missing.length > 0 || unexpected.length > 0 || failed.length > 0) {
    artifact.summary = summarize(artifact.scenarios);
    artifact.passed = false;
    await writeJsonAtomic(filePath, artifact);
    throw new Error(
      `hosting profile conformance incomplete: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"} failed=${failed.join(",") || "none"}`,
    );
  }
  artifact.summary = summarize(artifact.scenarios);
  artifact.passed = true;
  await writeJsonAtomic(filePath, artifact);
}

const [command, filePath, ...args] = process.argv.slice(2);
if (!command || !filePath) {
  throw new Error(usage());
}
if (command === "init") {
  await initArtifact(filePath, ...args);
} else if (command === "record") {
  await recordScenario(filePath, ...args);
} else if (command === "finalize") {
  await finalizeArtifact(filePath);
} else {
  throw new Error(usage());
}

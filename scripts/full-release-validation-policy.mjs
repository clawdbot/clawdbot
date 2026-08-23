import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const SUCCESSFUL_JOB_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);
const MAX_REPORTED_ISSUES = 25;
const MAX_SUMMARY_ISSUES = 5;
const MAX_LABEL_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;
const MAX_URL_LENGTH = 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const EXACT_TARGET_EVIDENCE_REUSE_POLICY = "exact-target-full-validation-v1";
const CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY = "changelog-only-release-v1";
export const HISTORICAL_CONTINUATION_SOURCE_MODE = "historical-exact-tuple";
const RELEASE_CI_SHA_PINNED_BRANCH_PATTERN = /^release-ci\/[a-f0-9]{12}-[1-9][0-9]*$/u;
const HISTORICAL_ROOT_RESOLVE_JOB_NAME = "Resolve target ref";
const HISTORICAL_RELEASE_CHECKS_RESOLVE_JOB_NAME = "resolve_target";
const HISTORICAL_REUSABLE_INPUT_JOB_NAME =
  "Prepare shared release candidate / validate_selected_ref";
const HISTORICAL_INPUT_ALIASES = Object.freeze({
  allow_unreleased_changelog: "allowUnreleasedChangelog",
  codex_plugin_spec: "codexPluginSpec",
  cross_os_suite_filter: "crossOsSuiteFilter",
  live_suite_filter: "liveSuiteFilter",
  mode: "mode",
  npm_telegram_package_spec: "npmTelegramPackageSpec",
  npm_telegram_provider_mode: "npmTelegramProviderMode",
  npm_telegram_scenario: "npmTelegramScenario",
  package_acceptance_package_spec: "packageAcceptancePackageSpec",
  plugin_prerelease_node_exclude_patterns_json: "pluginPrereleaseNodeExcludePatternsJson",
  provider: "provider",
  release_package_spec: "releasePackageSpec",
  skip_package_telegram_e2e: "skipPackageTelegramE2e",
  target_context_ref: "targetContextRef",
});
const HARD_GH_TRANSPORT_PATTERN =
  /HTTP (?:400|401|403|404|422)\b|Bad credentials|authentication required|not authenticated|gh auth login|unknown (?:command|flag)|Usage: gh\b|ENOENT|EACCES/iu;
const TRANSIENT_GH_TRANSPORT_PATTERN =
  /HTTP 429\b|HTTP 5[0-9][0-9]\b|Server Error|secondary rate limit|API rate limit|abuse detection|error connecting to|context deadline exceeded|connection reset by peer|connection refused|TLS handshake timeout|i\/o timeout|network is unreachable|unexpected EOF|ETIMEDOUT|ECONNRESET|EAI_AGAIN/iu;

const RELEASE_DECISION_STATES = Object.freeze([
  "qualifying",
  "blocked_diagnostics_running",
  "passed",
  "blocked_complete",
  "orchestration_error",
  "cancelled_with_children",
]);

const RELEASE_DECISION_STATE_SET = new Set(RELEASE_DECISION_STATES);
const CHILD_SPECS = Object.freeze([
  {
    dispatchName: "Dispatch CI",
    displayName: "CI",
    key: "normalCi",
    parentJobName: "Run normal full CI",
    rerunGroups: ["all", "ci"],
    suffix: "-ci",
    workflow: "ci.yml",
  },
  {
    dispatchName: "Dispatch plugin prerelease",
    displayName: "Plugin Prerelease",
    key: "pluginPrerelease",
    parentJobName: "Run plugin prerelease validation",
    rerunGroups: ["all", "plugin-prerelease"],
    suffix: "-plugin-prerelease",
    workflow: "plugin-prerelease.yml",
  },
  {
    dispatchName: "Dispatch release checks",
    displayName: "OpenClaw Release Checks",
    key: "releaseChecks",
    parentJobName: "Run release/live/Docker/QA validation",
    rerunGroups: [
      "all",
      "install-smoke",
      "cross-os",
      "live-e2e",
      "package",
      "qa-parity",
      "qa-live",
    ],
    suffix: "-release-checks",
    workflow: "openclaw-release-checks.yml",
  },
  {
    dispatchName: "Dispatch npm Telegram E2E",
    displayName: "NPM Telegram Beta E2E",
    key: "npmTelegram",
    parentJobName: "Run package Telegram E2E",
    rerunGroups: ["npm-telegram"],
    suffix: "-npm-telegram",
    workflow: "npm-telegram-beta-e2e.yml",
  },
  {
    dispatchName: "Dispatch OpenClaw Performance",
    displayName: "OpenClaw Performance",
    key: "productPerformance",
    parentJobName: "Run product performance evidence",
    rerunGroups: ["all", "performance"],
    suffix: "",
    workflow: "openclaw-performance.yml",
  },
]);
const RELEASE_CANDIDATE_KEYS = Object.freeze(
  [
    "imageArchiveSha256",
    "imageArtifactDigest",
    "imageArtifactId",
    "imageArtifactName",
    "imageArtifactRunAttempt",
    "imageArtifactRunId",
    "packageArtifactDigest",
    "packageArtifactId",
    "packageArtifactName",
    "packageArtifactRunAttempt",
    "packageArtifactRunId",
    "packageFileName",
    "packageSha256",
    "packageSourceSha",
    "packageVersion",
    "prepublishPluginRegistryArtifactDigest",
    "prepublishPluginRegistryArtifactId",
    "prepublishPluginRegistryArtifactName",
    "prepublishPluginRegistryArtifactRunAttempt",
    "prepublishPluginRegistryArtifactRunId",
    "prepublishPluginRegistryManifestSha256",
  ].toSorted(),
);
const RELEASE_VALIDATION_INPUT_KEYS = Object.freeze(
  [
    "allowUnreleasedChangelog",
    "codexPluginSpec",
    "crossOsSuiteFilter",
    "liveSuiteFilter",
    "mode",
    "npmTelegramPackageSpec",
    "npmTelegramProviderMode",
    "npmTelegramScenario",
    "packageAcceptancePackageSpec",
    "pluginPrereleaseNodeExcludePatternsJson",
    "provider",
    "releasePackageSpec",
    "skipPackageTelegramE2e",
    "targetContextRef",
  ].toSorted(),
);
const HISTORICAL_REUSABLE_INPUTS = Object.freeze([
  ["npm_telegram_provider_mode", "npmTelegramProviderMode"],
  ["npm_telegram_scenario", "npmTelegramScenario"],
  ["target_context_ref", "targetContextRef"],
]);

function releaseGhTransportErrorText(error) {
  const values = [error];
  const seen = new Set();
  const parts = [];
  while (values.length > 0) {
    const value = values.shift();
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      if (value instanceof Error) {
        parts.push(value.name, value.message);
      }
      for (const key of ["stderr", "stdout", "code", "signal", "cause"]) {
        if (key in value && value[key] !== undefined) {
          values.push(value[key]);
        }
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      parts.push(String(value));
    }
  }
  return parts.join("\n");
}

export function classifyReleaseGhTransportError(error) {
  const text = releaseGhTransportErrorText(error);
  if (HARD_GH_TRANSPORT_PATTERN.test(text)) {
    return "hard";
  }
  return TRANSIENT_GH_TRANSPORT_PATTERN.test(text) ? "transient" : "ambiguous";
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function boundedString(value, maxLength) {
  return stringValue(value)
    .replaceAll(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function positiveInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function booleanValue(value) {
  return value === true || value === "true";
}

export function releaseChildSpec(key) {
  const spec = CHILD_SPECS.find((entry) => entry.key === key);
  if (!spec) {
    throw new Error(`release child key is invalid: ${key}`);
  }
  return spec;
}

export function normalizeReleaseCandidate(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release candidate identity is invalid");
  }
  const candidate = canonicalValue(value);
  if (
    JSON.stringify(Object.keys(candidate).toSorted()) !== JSON.stringify(RELEASE_CANDIDATE_KEYS) ||
    !SHA_PATTERN.test(String(candidate.packageSourceSha ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(candidate.packageSha256 ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(candidate.imageArchiveSha256 ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(candidate.prepublishPluginRegistryManifestSha256 ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(candidate.packageArtifactDigest ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(candidate.imageArtifactDigest ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(candidate.prepublishPluginRegistryArtifactDigest ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(candidate.packageArtifactId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(candidate.imageArtifactId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(candidate.prepublishPluginRegistryArtifactId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(candidate.packageArtifactRunId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(candidate.imageArtifactRunId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(candidate.prepublishPluginRegistryArtifactRunId ?? "")) ||
    positiveInteger(candidate.packageArtifactRunAttempt) === undefined ||
    positiveInteger(candidate.imageArtifactRunAttempt) === undefined ||
    positiveInteger(candidate.prepublishPluginRegistryArtifactRunAttempt) === undefined ||
    !stringValue(candidate.packageArtifactName) ||
    !stringValue(candidate.imageArtifactName) ||
    !stringValue(candidate.prepublishPluginRegistryArtifactName) ||
    !stringValue(candidate.packageFileName) ||
    !stringValue(candidate.packageVersion) ||
    (expected.targetSha !== undefined && candidate.packageSourceSha !== expected.targetSha) ||
    (expected.parentRunId !== undefined &&
      [
        candidate.packageArtifactRunId,
        candidate.imageArtifactRunId,
        candidate.prepublishPluginRegistryArtifactRunId,
      ].some((runId) => String(runId) !== String(expected.parentRunId))) ||
    (expected.parentRunAttempt !== undefined &&
      [
        candidate.packageArtifactRunAttempt,
        candidate.imageArtifactRunAttempt,
        candidate.prepublishPluginRegistryArtifactRunAttempt,
      ].some((attempt) => Number(attempt) !== Number(expected.parentRunAttempt)))
  ) {
    throw new Error("release candidate identity is invalid");
  }
  return candidate;
}

export function normalizeReleaseValidationInputs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release validation inputs are incomplete");
  }
  const inputs = canonicalValue(value);
  if (
    JSON.stringify(Object.keys(inputs).toSorted()) !==
      JSON.stringify(RELEASE_VALIDATION_INPUT_KEYS) ||
    Object.values(inputs).some((entry) => typeof entry !== "string")
  ) {
    throw new Error("release validation inputs are incomplete");
  }
  return inputs;
}

export function isCanonicalReleaseContinuationWorkflowRef(workflowRef, workflowSha) {
  const ref = boundedString(workflowRef, MAX_LABEL_LENGTH);
  const sha = boundedString(workflowSha, MAX_LABEL_LENGTH);
  return (
    ref === "main" ||
    (SHA_PATTERN.test(sha) &&
      RELEASE_CI_SHA_PINNED_BRANCH_PATTERN.test(ref) &&
      ref.startsWith(`release-ci/${sha.slice(0, 12)}-`))
  );
}

export function requireCanonicalReleaseContinuationWorkflowRef(workflowRef, workflowSha) {
  if (!isCanonicalReleaseContinuationWorkflowRef(workflowRef, workflowSha)) {
    throw new Error(
      "legacy continuation source workflow ref is not a canonical trusted main or release-ci/<sha12>-<digits> route; run a new all-group FRV before continuing",
    );
  }
  return boundedString(workflowRef, MAX_LABEL_LENGTH);
}

function selectExactSuccessfulHistoricalJob(parentJobs, sourceRunAttempt, name, label) {
  const attempt = positiveInteger(sourceRunAttempt);
  const matches = Array.isArray(parentJobs)
    ? parentJobs.filter(
        (job) => job?.name === name && positiveInteger(job?.run_attempt) === attempt,
      )
    : [];
  if (
    matches.length !== 1 ||
    matches[0].status !== "completed" ||
    matches[0].conclusion !== "success"
  ) {
    throw new Error(`historical continuation ${label} job is missing or ambiguous`);
  }
  return matches[0];
}

export function selectHistoricalRootResolveJob(parentJobs, sourceRunAttempt) {
  return selectExactSuccessfulHistoricalJob(
    parentJobs,
    sourceRunAttempt,
    HISTORICAL_ROOT_RESOLVE_JOB_NAME,
    "root resolver",
  );
}

export function selectHistoricalReleaseChecksResolveJob(childJobs, childRunAttempt) {
  return selectExactSuccessfulHistoricalJob(
    childJobs,
    childRunAttempt,
    HISTORICAL_RELEASE_CHECKS_RESOLVE_JOB_NAME,
    "release-checks resolver",
  );
}

export function selectHistoricalReusableInputJob(parentJobs, sourceRunAttempt) {
  return selectExactSuccessfulHistoricalJob(
    parentJobs,
    sourceRunAttempt,
    HISTORICAL_REUSABLE_INPUT_JOB_NAME,
    "reusable input",
  );
}

function normalizedLogLine(rawLine) {
  return stripVTControlCharacters(String(rawLine)).replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u,
    "",
  );
}

function exactEnvironmentValues(log, expectedKeys, label) {
  const expected = new Set(expectedKeys);
  const blocks = [];
  let current;
  for (const rawLine of String(log ?? "").split(/\r?\n/gu)) {
    const line = normalizedLogLine(rawLine);
    if (/^\s*env:\s*$/u.test(line)) {
      if (current) {
        blocks.push(current);
      }
      current = new Map();
      continue;
    }
    if (!current) {
      continue;
    }
    const match = line.match(/^\s+([A-Z][A-Z0-9_]+):(?: (.*))?$/u);
    if (!match) {
      if (current.size > 0) {
        blocks.push(current);
        current = undefined;
      }
      continue;
    }
    if (!expected.has(match[1])) {
      continue;
    }
    if (current.has(match[1])) {
      throw new Error(`historical continuation ${label} is duplicated: ${match[1]}`);
    }
    current.set(match[1], match[2] ?? "");
  }
  if (current) {
    blocks.push(current);
  }
  const matches = blocks.filter((block) => [...expected].every((key) => block.has(key)));
  if (matches.length !== 1) {
    throw new Error(`historical continuation ${label} block is missing or ambiguous`);
  }
  return matches[0];
}

function parseHistoricalWorkflowDispatchDefaults(workflowSource) {
  const defaults = new Map();
  let currentInput;
  let dispatchIndent = -1;
  let inputIndent = -1;
  let inputsIndent = -1;
  let inDispatch = false;
  let inInputs = false;
  for (const rawLine of String(workflowSource ?? "").split(/\r?\n/gu)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (!inDispatch) {
      if (line === "workflow_dispatch:") {
        dispatchIndent = indent;
        inDispatch = true;
      }
      continue;
    }
    if (indent <= dispatchIndent) {
      break;
    }
    if (!inInputs) {
      if (line === "inputs:") {
        inInputs = true;
        inputsIndent = indent;
      }
      continue;
    }
    if (indent <= inputsIndent) {
      break;
    }
    const inputMatch = line.match(/^([a-z][a-z0-9_]*):$/u);
    if (inputMatch && (inputIndent === -1 || indent === inputIndent)) {
      inputIndent = indent;
      currentInput = inputMatch[1];
      continue;
    }
    if (!currentInput || indent <= inputIndent) {
      throw new Error("historical continuation workflow input schema is invalid");
    }
    const defaultMatch = line.match(/^default:\s*(.*)$/u);
    if (!defaultMatch) {
      continue;
    }
    if (defaults.has(currentInput)) {
      throw new Error(
        `historical continuation workflow input default is duplicated: ${currentInput}`,
      );
    }
    const rawValue = defaultMatch[1].trim();
    let value;
    if (rawValue === '""' || rawValue === "''") {
      value = "";
    } else if (/^(?:true|false)$/u.test(rawValue)) {
      value = rawValue;
    } else if (/^"(?:[^"\\]|\\.)*"$/u.test(rawValue)) {
      value = JSON.parse(rawValue);
    } else if (/^[A-Za-z0-9@./_-]+$/u.test(rawValue)) {
      value = rawValue;
    } else {
      throw new Error(
        `historical continuation workflow input default is unsupported: ${currentInput}`,
      );
    }
    defaults.set(currentInput, String(value));
  }
  if (!inDispatch || !inInputs) {
    throw new Error("historical continuation workflow dispatch schema is missing");
  }
  for (const key of Object.keys(HISTORICAL_INPUT_ALIASES)) {
    if (!defaults.has(key)) {
      throw new Error(`historical continuation workflow input default is missing: ${key}`);
    }
  }
  return defaults;
}

function parseHistoricalInputsGroup(log) {
  const groups = [];
  let current;
  for (const rawLine of String(log ?? "").split(/\r?\n/gu)) {
    const line = normalizedLogLine(rawLine);
    if (/^\s*##\[group\]\s+Inputs\s*$/u.test(line)) {
      if (current) {
        throw new Error("historical continuation reusable Inputs group is nested");
      }
      current = new Map();
      continue;
    }
    if (/^\s*##\[endgroup\]\s*$/u.test(line)) {
      if (current) {
        groups.push(current);
        current = undefined;
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/u);
    if (!match) {
      if (line.trim()) {
        throw new Error("historical continuation reusable Inputs group is incomplete");
      }
      continue;
    }
    const canonicalKey =
      HISTORICAL_INPUT_ALIASES[match[1]] ??
      (RELEASE_VALIDATION_INPUT_KEYS.includes(match[1]) ? match[1] : undefined);
    if (!canonicalKey) {
      continue;
    }
    if (current.has(canonicalKey)) {
      throw new Error(`historical continuation reusable input is duplicated: ${canonicalKey}`);
    }
    current.set(canonicalKey, match[2] ?? "");
  }
  if (current || groups.length !== 1) {
    throw new Error("historical continuation reusable Inputs group is missing or ambiguous");
  }
  return groups[0];
}

function verifyHistoricalCandidateArtifacts(evidence, source) {
  const candidate = source.candidate;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("historical continuation candidate artifact evidence is missing");
  }
  const specs = [
    ["image", "imageArtifactId", "imageArtifactName", "imageArtifactDigest"],
    ["package", "packageArtifactId", "packageArtifactName", "packageArtifactDigest"],
    [
      "pluginRegistry",
      "prepublishPluginRegistryArtifactId",
      "prepublishPluginRegistryArtifactName",
      "prepublishPluginRegistryArtifactDigest",
    ],
  ];
  for (const [key, idKey, nameKey, digestKey] of specs) {
    const artifact = evidence[key];
    if (
      !artifact ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      String(artifact.id) !== String(candidate[idKey]) ||
      artifact.name !== candidate[nameKey] ||
      artifact.digest !== `sha256:${candidate[digestKey]}` ||
      artifact.archiveSha256 !== candidate[digestKey] ||
      artifact.expired !== false ||
      String(artifact.runId) !== source.sourceRunId ||
      Number(artifact.runAttempt) !== source.sourceRunAttempt ||
      artifact.workflowRef !== source.sourceWorkflowRef ||
      artifact.workflowSha !== source.sourceWorkflowSha
    ) {
      throw new Error(`historical continuation ${key} artifact identity changed`);
    }
  }
  if (
    evidence.package.fileName !== candidate.packageFileName ||
    evidence.package.fileSha256 !== candidate.packageSha256 ||
    evidence.package.packageName !== "openclaw" ||
    evidence.package.packageVersion !== candidate.packageVersion ||
    evidence.package.packageSourceSha !== candidate.packageSourceSha
  ) {
    throw new Error("historical continuation package artifact contents changed");
  }
  if (
    evidence.pluginRegistry.manifestSha256 !== candidate.prepublishPluginRegistryManifestSha256 ||
    evidence.pluginRegistry.schema !== "openclaw.prepublish-plugin-registry/v1" ||
    evidence.pluginRegistry.schemaVersion !== 1 ||
    evidence.pluginRegistry.sourceSha !== candidate.packageSourceSha ||
    evidence.pluginRegistry.candidateVersion !== candidate.packageVersion
  ) {
    throw new Error("historical continuation plugin registry artifact contents changed");
  }
  if (
    evidence.image.imageArchiveSha256 !== candidate.imageArchiveSha256 ||
    evidence.image.imageArchiveFileName !== "shared-images.tar.zst" ||
    evidence.image.imageArchiveFormat !== "docker-tar+zstd" ||
    evidence.image.imageArchiveManifestSha256 !== candidate.imageArchiveSha256 ||
    evidence.image.imageConclusion !== "success" ||
    evidence.image.imageKind !== "docker-e2e" ||
    evidence.image.imageSchema !== "openclaw.shared-docker-image-artifact/v1" ||
    evidence.image.imageSchemaVersion !== 1 ||
    evidence.image.targetSha !== candidate.packageSourceSha ||
    evidence.image.packageSourceSha !== candidate.packageSourceSha ||
    evidence.image.packageSha256 !== candidate.packageSha256 ||
    evidence.image.imageWorkflowSha !== source.sourceWorkflowSha ||
    String(evidence.image.manifestRunId) !== source.sourceRunId ||
    Number(evidence.image.manifestRunAttempt) !== source.sourceRunAttempt
  ) {
    throw new Error("historical continuation image artifact contents changed");
  }
}

function verifyHistoricalReleaseContinuationEvidence(evidence, continuation) {
  const source = normalizedContinuation(continuation);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("historical continuation source evidence is missing");
  }
  const rootExpected = {
    RELEASE_PROFILE: source.releaseProfile,
    RUN_RELEASE_SOAK: source.runReleaseSoak,
    ALLOW_UNRELEASED_CHANGELOG: source.validationInputs.allowUnreleasedChangelog,
    CODEX_PLUGIN_SPEC: source.validationInputs.codexPluginSpec,
    CROSS_OS_SUITE_FILTER: source.validationInputs.crossOsSuiteFilter,
    LIVE_SUITE_FILTER: source.validationInputs.liveSuiteFilter,
    NPM_TELEGRAM_PACKAGE_SPEC: source.validationInputs.npmTelegramPackageSpec,
    PACKAGE_ACCEPTANCE_PACKAGE_SPEC: source.validationInputs.packageAcceptancePackageSpec,
    PLUGIN_PRERELEASE_NODE_EXCLUDE_PATTERNS_JSON:
      source.validationInputs.pluginPrereleaseNodeExcludePatternsJson,
    RELEASE_PACKAGE_SPEC: source.validationInputs.releasePackageSpec,
    SKIP_PACKAGE_TELEGRAM_E2E: source.validationInputs.skipPackageTelegramE2e,
  };
  const rootObserved = exactEnvironmentValues(
    evidence.rootResolveLog,
    Object.keys(rootExpected),
    "root resolver input",
  );
  for (const [key, value] of Object.entries(rootExpected)) {
    if (!rootObserved.has(key)) {
      throw new Error(`historical continuation root resolver input is missing: ${key}`);
    }
    if (rootObserved.get(key) !== value) {
      throw new Error(`historical continuation root resolver input changed: ${key}`);
    }
  }
  const childExpected = {
    RELEASE_MODE_INPUT: source.validationInputs.mode,
    RELEASE_PROVIDER_INPUT: source.validationInputs.provider,
    RELEASE_REF_INPUT: source.candidate.packageSourceSha,
  };
  const childObserved = exactEnvironmentValues(
    evidence.releaseChecksResolveLog,
    ["CANDIDATE_ARTIFACT_JSON_INPUT", ...Object.keys(childExpected)],
    "release-checks resolver input",
  );
  for (const [key, value] of Object.entries(childExpected)) {
    if (!childObserved.has(key)) {
      throw new Error(`historical continuation release-checks resolver input is missing: ${key}`);
    }
    if (childObserved.get(key) !== value) {
      throw new Error(`historical continuation release-checks resolver input changed: ${key}`);
    }
  }
  if (!childObserved.has("CANDIDATE_ARTIFACT_JSON_INPUT")) {
    throw new Error(
      "historical continuation release-checks resolver input is missing: CANDIDATE_ARTIFACT_JSON_INPUT",
    );
  }
  let loggedCandidate;
  try {
    loggedCandidate = normalizeReleaseCandidate(
      JSON.parse(childObserved.get("CANDIDATE_ARTIFACT_JSON_INPUT")),
      {
        parentRunAttempt: source.sourceRunAttempt,
        parentRunId: source.sourceRunId,
        targetSha: source.candidate.packageSourceSha,
      },
    );
  } catch (error) {
    throw new Error("historical continuation release-checks resolver candidate is invalid", {
      cause: error,
    });
  }
  if (JSON.stringify(loggedCandidate) !== JSON.stringify(source.candidate)) {
    throw new Error(
      "historical continuation release-checks resolver input changed: CANDIDATE_ARTIFACT_JSON_INPUT",
    );
  }
  const defaults = parseHistoricalWorkflowDispatchDefaults(evidence.sourceWorkflow);
  const reusableInputs = parseHistoricalInputsGroup(evidence.reusableInputsLog);
  for (const [schemaKey, canonicalKey] of HISTORICAL_REUSABLE_INPUTS) {
    const expectedValue = source.validationInputs[canonicalKey];
    if (reusableInputs.has(canonicalKey)) {
      if (reusableInputs.get(canonicalKey) !== expectedValue) {
        throw new Error(`historical continuation reusable input changed: ${canonicalKey}`);
      }
      continue;
    }
    if (defaults.get(schemaKey) !== "" || expectedValue !== "") {
      throw new Error(`historical continuation reusable input is missing: ${canonicalKey}`);
    }
  }
  verifyHistoricalCandidateArtifacts(evidence.candidateArtifacts, source);
  return {
    candidateArtifacts: canonicalValue(evidence.candidateArtifacts),
    releaseChecksInputs: canonicalValue(Object.fromEntries(childObserved)),
    reusableInputs: canonicalValue(Object.fromEntries(reusableInputs)),
    rootInputs: canonicalValue(Object.fromEntries(rootObserved)),
  };
}

function normalizedContinuation(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release execution plan continuation is invalid");
  }
  const candidate = normalizeReleaseCandidate(value.candidate, {
    parentRunAttempt: value.sourceRunAttempt,
    parentRunId: value.sourceRunId,
  });
  const validationInputs = normalizeReleaseValidationInputs(value.validationInputs);
  const sourceEvidenceMode =
    value.sourceEvidenceMode === undefined
      ? undefined
      : boundedString(value.sourceEvidenceMode, MAX_LABEL_LENGTH);
  const continuation = {
    candidate,
    publicationEnabled: value.publicationEnabled === true,
    releaseProfile: boundedString(value.releaseProfile, MAX_LABEL_LENGTH),
    rerunGroup: boundedString(value.rerunGroup, MAX_LABEL_LENGTH),
    runReleaseSoak: boundedString(value.runReleaseSoak, MAX_LABEL_LENGTH),
    sourceDisplayTitle: boundedString(value.sourceDisplayTitle, MAX_LABEL_LENGTH),
    sourceEvent: boundedString(value.sourceEvent, MAX_LABEL_LENGTH),
    sourceRepository: boundedString(value.sourceRepository, MAX_LABEL_LENGTH),
    sourceRunAttempt: positiveInteger(value.sourceRunAttempt),
    sourceRunId: boundedString(value.sourceRunId, MAX_LABEL_LENGTH),
    sourceWorkflowPath: boundedString(value.sourceWorkflowPath, MAX_LABEL_LENGTH),
    sourceWorkflowRef: boundedString(value.sourceWorkflowRef, MAX_LABEL_LENGTH),
    sourceWorkflowSha: boundedString(value.sourceWorkflowSha, MAX_LABEL_LENGTH),
    ...(sourceEvidenceMode === undefined ? {} : { sourceEvidenceMode }),
    toolingSha: boundedString(value.toolingSha, MAX_LABEL_LENGTH),
    validationInputs,
  };
  if (sourceEvidenceMode === HISTORICAL_CONTINUATION_SOURCE_MODE) {
    requireCanonicalReleaseContinuationWorkflowRef(
      continuation.sourceWorkflowRef,
      continuation.sourceWorkflowSha,
    );
  }
  if (
    continuation.publicationEnabled ||
    candidate.packageSourceSha === "" ||
    !["beta", "stable", "full"].includes(continuation.releaseProfile) ||
    continuation.rerunGroup !== "all" ||
    !["true", "false"].includes(continuation.runReleaseSoak) ||
    !continuation.sourceDisplayTitle ||
    continuation.sourceEvent !== "workflow_dispatch" ||
    !/^[^/]+\/[^/]+$/u.test(continuation.sourceRepository) ||
    !/^[1-9][0-9]*$/u.test(continuation.sourceRunId) ||
    continuation.sourceRunAttempt === undefined ||
    continuation.sourceWorkflowPath !== ".github/workflows/full-release-validation.yml" ||
    !continuation.sourceWorkflowRef ||
    !SHA_PATTERN.test(continuation.sourceWorkflowSha) ||
    (sourceEvidenceMode !== undefined &&
      sourceEvidenceMode !== HISTORICAL_CONTINUATION_SOURCE_MODE) ||
    !SHA_PATTERN.test(continuation.toolingSha)
  ) {
    throw new Error("release execution plan continuation binding is invalid");
  }
  return continuation;
}

function continuationManifestChildRunIds(manifest) {
  const children = manifest?.childRunIds ?? manifest?.childRuns;
  if (!children || typeof children !== "object" || Array.isArray(children)) {
    throw new Error("continuation source child inventory is invalid");
  }
  const keys = CHILD_SPECS.map((spec) => spec.key).toSorted();
  if (JSON.stringify(Object.keys(children).toSorted()) !== JSON.stringify(keys)) {
    throw new Error("continuation source child inventory is invalid");
  }
  return Object.fromEntries(
    keys.map((key) => {
      const value =
        key === "productPerformance" &&
        children[key] &&
        typeof children[key] === "object" &&
        !Array.isArray(children[key])
          ? children[key].runId
          : children[key];
      const runId = String(value ?? "");
      if (runId && !/^[1-9][0-9]*$/u.test(runId)) {
        throw new Error("continuation source child inventory is invalid");
      }
      return [key, runId];
    }),
  );
}

function continuationSourceChildren(children, source, validationInputs) {
  if (!Array.isArray(children)) {
    throw new Error("continuation source child inventory is invalid");
  }
  const requiredKeys = [
    "normalCi",
    "pluginPrerelease",
    "productPerformance",
    "releaseChecks",
    ...(validationInputs.npmTelegramPackageSpec || validationInputs.releasePackageSpec
      ? ["npmTelegram"]
      : []),
  ].toSorted();
  const normalized = children
    .filter((child) => child?.selected !== false)
    .map((child) => {
      const spec = releaseChildSpec(child.key);
      const entry = {
        displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
        key: spec.key,
        runAttempt: positiveInteger(child.runAttempt),
        runId: boundedString(child.runId, MAX_LABEL_LENGTH),
        sourceParentAttempt: positiveInteger(child.sourceParentAttempt),
        workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
        workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
        workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
      };
      if (
        !/^[1-9][0-9]*$/u.test(entry.runId) ||
        entry.runAttempt === undefined ||
        entry.sourceParentAttempt === undefined ||
        entry.sourceParentAttempt > source.sourceRunAttempt ||
        entry.workflow !== spec.workflow ||
        entry.workflowRef !== source.sourceWorkflowRef ||
        entry.workflowSha !== source.sourceWorkflowSha ||
        entry.displayTitle !==
          `${spec.displayName} full-release-validation-${source.sourceRunId}-${entry.sourceParentAttempt}${spec.suffix}`
      ) {
        throw new Error(`continuation source child identity is invalid: ${entry.key}`);
      }
      return entry;
    })
    .toSorted((left, right) => left.key.localeCompare(right.key));
  if (
    JSON.stringify(normalized.map((child) => child.key)) !== JSON.stringify(requiredKeys) ||
    new Set(normalized.map((child) => child.key)).size !== normalized.length
  ) {
    throw new Error("continuation source child inventory is invalid");
  }
  return normalized;
}

export function verifyReleaseContinuationSourceIdentity({
  continuation,
  recordedContinuation,
  repository,
  sourceRun,
  targetSha,
}) {
  const source = normalizedContinuation(continuation);
  if (
    recordedContinuation !== undefined &&
    JSON.stringify(normalizedContinuation(recordedContinuation)) !== JSON.stringify(source)
  ) {
    throw new Error("recorded continuation source differs from the immutable plan");
  }
  const normalizedRepository = boundedString(repository, MAX_LABEL_LENGTH);
  const normalizedTargetSha = boundedString(targetSha, MAX_LABEL_LENGTH);
  if (
    String(sourceRun?.id) !== source.sourceRunId ||
    Number(sourceRun?.run_attempt) !== source.sourceRunAttempt ||
    sourceRun?.display_title !== source.sourceDisplayTitle ||
    sourceRun?.event !== source.sourceEvent ||
    String(sourceRun?.path ?? "").split("@", 1)[0] !== source.sourceWorkflowPath ||
    sourceRun?.head_branch !== source.sourceWorkflowRef ||
    sourceRun?.head_sha !== source.sourceWorkflowSha ||
    sourceRun?.repository?.full_name !== normalizedRepository ||
    source.sourceRepository !== normalizedRepository ||
    sourceRun?.status !== "completed"
  ) {
    throw new Error("source full release parent identity changed");
  }
  if (source.candidate.packageSourceSha !== normalizedTargetSha) {
    throw new Error("continuation source identity differs from the immutable plan");
  }
  return source;
}

export function verifyReleaseContinuationSource({
  children,
  continuation,
  recordedContinuation,
  repository,
  sourceChildLogs,
  historicalEvidence,
  sourceManifest,
  sourceRun,
  targetSha,
}) {
  const source = verifyReleaseContinuationSourceIdentity({
    continuation,
    recordedContinuation,
    repository,
    sourceRun,
    targetSha,
  });
  const normalizedRepository = boundedString(repository, MAX_LABEL_LENGTH);
  const normalizedTargetSha = boundedString(targetSha, MAX_LABEL_LENGTH);
  const normalizedChildren = continuationSourceChildren(children, source, source.validationInputs);
  const expectedRunIds = Object.fromEntries(CHILD_SPECS.map((spec) => [spec.key, ""]));
  for (const child of normalizedChildren) {
    expectedRunIds[child.key] = child.runId;
    validateReleaseChildDispatchBinding({
      candidate: source.candidate,
      child,
      log: sourceChildLogs?.[child.key],
      plannedRunAttempt: child.runAttempt,
      repository: normalizedRepository,
      targetSha: normalizedTargetSha,
    });
  }
  if (!sourceManifest) {
    if (source.sourceEvidenceMode !== HISTORICAL_CONTINUATION_SOURCE_MODE) {
      throw new Error("continuation source manifest is missing");
    }
    verifyHistoricalReleaseContinuationEvidence(historicalEvidence, source);
    return {
      children: normalizedChildren,
      continuation: source,
      sourceManifest: null,
    };
  }

  const manifestInputs = normalizeReleaseValidationInputs(sourceManifest.validationInputs);
  const manifestControls = sourceManifest.controls;
  if (
    String(sourceManifest.runId) !== source.sourceRunId ||
    Number(sourceManifest.runAttempt) !== source.sourceRunAttempt ||
    sourceManifest.workflowRef !== source.sourceWorkflowRef ||
    sourceManifest.workflowSha !== source.sourceWorkflowSha ||
    sourceManifest.targetSha !== normalizedTargetSha ||
    sourceManifest.releaseProfile !== source.releaseProfile ||
    sourceManifest.rerunGroup !== "all" ||
    sourceManifest.runReleaseSoak !== source.runReleaseSoak ||
    manifestControls?.performanceReportPublication !== "artifact-only" ||
    JSON.stringify(manifestInputs) !== JSON.stringify(source.validationInputs)
  ) {
    throw new Error("continuation source identity differs from the immutable plan");
  }
  const manifestChildRunIds = continuationManifestChildRunIds(sourceManifest);
  for (const child of normalizedChildren) {
    const evidence = sourceManifest.childEvidence?.[child.key];
    if (
      evidence &&
      (Number(evidence.plannedRunAttempt) !== child.runAttempt ||
        String(evidence.runId) !== child.runId)
    ) {
      throw new Error(`continuation source child attempt differs: ${child.key}`);
    }
  }
  if (JSON.stringify(manifestChildRunIds) !== JSON.stringify(canonicalValue(expectedRunIds))) {
    throw new Error("continuation source child inventory differs from the immutable plan");
  }
  return {
    children: normalizedChildren,
    continuation: source,
    sourceManifest: {
      childRunIds: manifestChildRunIds,
      controls: canonicalValue(manifestControls),
      releaseProfile: sourceManifest.releaseProfile,
      rerunGroup: sourceManifest.rerunGroup,
      runAttempt: Number(sourceManifest.runAttempt),
      runId: String(sourceManifest.runId),
      runReleaseSoak: sourceManifest.runReleaseSoak,
      targetSha: sourceManifest.targetSha,
      validationInputs: manifestInputs,
      workflowRef: sourceManifest.workflowRef,
      workflowSha: sourceManifest.workflowSha,
    },
  };
}

function normalizedAttemptJob(job, runAttempt) {
  const name = boundedString(job?.name, MAX_LABEL_LENGTH);
  if (!name) {
    throw new Error(`release child attempt ${runAttempt} contains an unnamed job`);
  }
  return {
    acceptedRunAttempt: runAttempt,
    completedAt: stringValue(job?.completed_at ?? job?.completedAt),
    conclusion: boundedString(job?.conclusion, MAX_LABEL_LENGTH),
    name,
    startedAt: stringValue(job?.started_at ?? job?.startedAt),
    status: boundedString(job?.status, MAX_LABEL_LENGTH),
    url: boundedString(job?.html_url ?? job?.url, MAX_URL_LENGTH),
  };
}

export function validateReleaseChildRunProvenance(run, expected = {}) {
  const plannedRunAttempt = positiveInteger(expected.plannedRunAttempt);
  const effectiveRunAttempt = positiveInteger(run?.run_attempt);
  const path = stringValue(run?.path).split("@", 1)[0];
  const dispatchActor = boundedString(run?.actor?.login, MAX_LABEL_LENGTH);
  const triggeringActor = boundedString(run?.triggering_actor?.login, MAX_LABEL_LENGTH);
  if (
    plannedRunAttempt === undefined ||
    effectiveRunAttempt === undefined ||
    effectiveRunAttempt < plannedRunAttempt ||
    String(run?.id ?? "") !== String(expected.runId ?? "") ||
    run?.event !== "workflow_dispatch" ||
    path !== `.github/workflows/${expected.workflow}` ||
    run?.display_title !== expected.displayTitle ||
    run?.head_branch !== expected.workflowRef ||
    run?.head_sha !== expected.workflowSha ||
    (expected.repository !== undefined &&
      run?.repository?.full_name !== String(expected.repository)) ||
    dispatchActor !== "github-actions[bot]" ||
    !triggeringActor ||
    (effectiveRunAttempt === plannedRunAttempt && triggeringActor !== "github-actions[bot]")
  ) {
    throw new Error(`release child provenance changed: ${expected.key ?? expected.runId}`);
  }
  return {
    dispatchActor,
    effectiveRunAttempt,
    repository: stringValue(run?.repository?.full_name, stringValue(expected.repository)),
    triggeringActor,
  };
}

function compositeJobsDigestPayload(value) {
  return {
    effectiveRunAttempt: value.effectiveRunAttempt,
    jobs: value.jobs,
    plannedRunAttempt: value.plannedRunAttempt,
  };
}

export function releaseCompositeJobsSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(compositeJobsDigestPayload(value))))
    .digest("hex");
}

export function composeReleaseAttemptJobs(attempts, expected = {}) {
  const plannedRunAttempt = positiveInteger(expected.plannedRunAttempt);
  const effectiveRunAttempt = positiveInteger(expected.effectiveRunAttempt);
  if (
    plannedRunAttempt === undefined ||
    effectiveRunAttempt === undefined ||
    effectiveRunAttempt < plannedRunAttempt
  ) {
    throw new Error("release child attempt range is invalid");
  }
  if (!Array.isArray(attempts)) {
    throw new Error("release child attempt evidence is invalid");
  }
  const normalizedAttempts = attempts.map((attempt) => ({
    jobs: Array.isArray(attempt?.jobs) ? attempt.jobs : [],
    runAttempt: positiveInteger(attempt?.runAttempt),
  }));
  const expectedCount = effectiveRunAttempt - plannedRunAttempt + 1;
  if (normalizedAttempts.length !== expectedCount) {
    throw new Error("release child attempt evidence is gapped");
  }

  const accepted = new Map();
  for (let index = 0; index < normalizedAttempts.length; index += 1) {
    const attempt = normalizedAttempts[index];
    const expectedAttempt = plannedRunAttempt + index;
    if (attempt.runAttempt !== expectedAttempt || attempt.jobs.length === 0) {
      throw new Error("release child attempt evidence is gapped");
    }
    const names = new Set();
    for (const rawJob of attempt.jobs) {
      const job = normalizedAttemptJob(rawJob, expectedAttempt);
      if (names.has(job.name)) {
        throw new Error(
          `release child attempt ${expectedAttempt} contains duplicate job identity: ${job.name}`,
        );
      }
      names.add(job.name);
      accepted.set(job.name, job);
    }
  }

  const composite = {
    effectiveRunAttempt,
    jobs: [...accepted.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    plannedRunAttempt,
  };
  return { ...composite, sha256: releaseCompositeJobsSha256(composite) };
}

export function composeReleaseChildAttemptEvidence({ attempts, expected, run }) {
  const provenance = validateReleaseChildRunProvenance(run, expected);
  const composite = composeReleaseAttemptJobs(attempts, {
    effectiveRunAttempt: provenance.effectiveRunAttempt,
    plannedRunAttempt: expected.plannedRunAttempt,
  });
  return {
    compositeJobsSha256: composite.sha256,
    dispatchActor: provenance.dispatchActor,
    effectiveRunAttempt: composite.effectiveRunAttempt,
    jobs: composite.jobs,
    observedRunAttempts: attempts.map((attempt) => attempt.runAttempt),
    plannedRunAttempt: composite.plannedRunAttempt,
    repository: provenance.repository,
    runId: String(run.id),
    triggeringActor: provenance.triggeringActor,
  };
}

export function validateReleaseChildDispatchBinding({
  candidate,
  child,
  log,
  plannedRunAttempt,
  repository,
  targetSha,
}) {
  const escapedRepo = String(repository).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactPattern = new RegExp(
    `https://github\\.com/${escapedRepo}/actions/runs/([1-9][0-9]*) \\(attempt ([1-9][0-9]*)\\)`,
    "gu",
  );
  const urlPattern = new RegExp(
    `https://github\\.com/${escapedRepo}/actions/runs/([1-9][0-9]*)`,
    "gu",
  );
  const exact = Array.from(String(log).matchAll(exactPattern), (match) => ({
    runAttempt: Number(match[2]),
    runId: match[1],
  }));
  const runIds = [...new Set(Array.from(String(log).matchAll(urlPattern), (match) => match[1]))];
  const exactBound =
    exact.length === 1 &&
    exact[0].runId === String(child.runId) &&
    exact[0].runAttempt === Number(plannedRunAttempt);
  const historicalUrlBound =
    exact.length === 0 && runIds.length === 1 && runIds[0] === String(child.runId);
  if (!exactBound && !historicalUrlBound) {
    throw new Error(`release child is not uniquely emitted by its parent job: ${child.key}`);
  }
  if (child.key !== "npmTelegram" && !String(log).includes(`TARGET_SHA: ${targetSha}`)) {
    throw new Error(`release child parent target SHA changed: ${child.key}`);
  }
  if (child.key === "productPerformance" && !String(log).includes("-f publish_reports=false")) {
    throw new Error("release performance child is not dispatched in artifact-only mode");
  }
  if (candidate && ["pluginPrerelease", "releaseChecks"].includes(child.key)) {
    const matches = Array.from(
      String(log).matchAll(/CANDIDATE_ARTIFACT_JSON:\s*(\{[^\r\n]+\})/gu),
      (match) => match[1],
    );
    if (matches.length !== 1) {
      throw new Error(`release child candidate binding is missing or duplicated: ${child.key}`);
    }
    let observed;
    try {
      observed = canonicalValue(JSON.parse(matches[0]));
    } catch {
      throw new Error(`release child candidate binding is invalid: ${child.key}`);
    }
    if (JSON.stringify(observed) !== JSON.stringify(canonicalValue(candidate))) {
      throw new Error(`release child candidate identity changed: ${child.key}`);
    }
  }
}

function candidatePreparationRequired(input) {
  if (
    input.continuation ||
    booleanValue(input.evidenceReuse) ||
    stringValue(input.releasePackageSpec).trim() ||
    stringValue(input.packageAcceptancePackageSpec).trim()
  ) {
    return false;
  }
  if (["all", "plugin-prerelease", "cross-os", "package"].includes(input.rerunGroup)) {
    return true;
  }
  return input.rerunGroup === "live-e2e" && !stringValue(input.liveSuiteFilter).trim();
}

export function buildReleaseExecutionPlan(input) {
  const parentRunId = stringValue(input.parentRunId).trim();
  const parentRunAttempt = positiveInteger(input.parentRunAttempt);
  const rerunGroup = stringValue(input.rerunGroup).trim();
  if (!parentRunId || parentRunAttempt === undefined || !rerunGroup) {
    throw new Error("release execution plan identity is invalid");
  }
  const reused = booleanValue(input.evidenceReuse);
  const continuation = input.continuation !== undefined && input.continuation !== null;
  const childInputs =
    input.children && typeof input.children === "object" && !Array.isArray(input.children)
      ? input.children
      : {};
  const npmTelegramForAll =
    rerunGroup === "all" &&
    Boolean(
      stringValue(input.npmTelegramPackageSpec).trim() ||
      stringValue(input.releasePackageSpec).trim(),
    );
  const children = CHILD_SPECS.map((spec) => {
    const raw = childInputs[spec.key] ?? {};
    const required =
      spec.key === "npmTelegram"
        ? rerunGroup === "npm-telegram" || npmTelegramForAll
        : spec.rerunGroups.includes(rerunGroup);
    const dispatchId = `full-release-validation-${parentRunId}-${parentRunAttempt}${spec.suffix}`;
    return {
      dispatchName: spec.dispatchName,
      displayTitle: continuation
        ? stringValue(raw.displayTitle).trim()
        : `${spec.displayName} ${dispatchId}`,
      key: spec.key,
      required,
      result: continuation && required ? "success" : stringValue(raw.result, "skipped"),
      runAttempt: positiveInteger(raw.runAttempt) ?? null,
      runId: stringValue(raw.runId).trim(),
      selected: required,
      source: continuation ? "continuation" : reused ? "reused" : "fresh",
      sourceParentAttempt: continuation ? (positiveInteger(raw.sourceParentAttempt) ?? null) : null,
      url: stringValue(raw.url).trim(),
      workflow: continuation ? stringValue(raw.workflow).trim() : spec.workflow,
      workflowRef: continuation
        ? stringValue(raw.workflowRef).trim()
        : stringValue(input.workflowRef).trim(),
      workflowSha: continuation
        ? stringValue(raw.workflowSha).trim()
        : stringValue(input.workflowSha).trim(),
    };
  });
  const gates = [
    {
      name: "Resolve target ref",
      required: true,
      result: stringValue(input.resolveTargetResult, "missing"),
    },
    {
      name: "Verify Docker runtime image assets",
      required: !continuation && !reused && rerunGroup === "all",
      result: stringValue(input.dockerPreflightResult, "skipped"),
    },
    {
      name: "Prepare shared release candidate",
      required: candidatePreparationRequired(input),
      result: stringValue(input.prepareCandidateResult, "skipped"),
    },
  ];
  return { children, gates };
}

function normalizedGate(gate) {
  return {
    name: boundedString(gate?.name, MAX_LABEL_LENGTH),
    required: gate?.required === true,
    result: boundedString(gate?.result, MAX_LABEL_LENGTH),
  };
}

function normalizedEvidenceReuse(evidenceReuse) {
  if (!evidenceReuse || evidenceReuse.requested !== true) {
    return { requested: false };
  }
  return {
    changedPaths: Array.isArray(evidenceReuse.changedPaths)
      ? evidenceReuse.changedPaths
          .map((value) => boundedString(value, MAX_LABEL_LENGTH))
          .filter(Boolean)
      : [],
    evidenceSha: boundedString(evidenceReuse.evidenceSha, MAX_LABEL_LENGTH),
    policy: boundedString(evidenceReuse.policy, MAX_LABEL_LENGTH),
    requested: true,
    rootRunId: boundedString(evidenceReuse.rootRunId, MAX_LABEL_LENGTH),
    runUrl: boundedString(evidenceReuse.runUrl, MAX_URL_LENGTH),
    selectedRunId: boundedString(evidenceReuse.selectedRunId, MAX_LABEL_LENGTH),
    sourceManifest:
      evidenceReuse.sourceManifest &&
      typeof evidenceReuse.sourceManifest === "object" &&
      !Array.isArray(evidenceReuse.sourceManifest)
        ? structuredClone(evidenceReuse.sourceManifest)
        : null,
  };
}

function validEvidenceReuseIdentity(evidenceReuse) {
  if (!evidenceReuse.requested) {
    return true;
  }
  const validChangedPaths =
    (evidenceReuse.policy === EXACT_TARGET_EVIDENCE_REUSE_POLICY &&
      evidenceReuse.changedPaths.length === 0) ||
    (evidenceReuse.policy === CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY &&
      evidenceReuse.changedPaths.length === 1 &&
      evidenceReuse.changedPaths[0] === "CHANGELOG.md");
  return (
    /^[a-f0-9]{40}$/u.test(evidenceReuse.evidenceSha) &&
    /^[1-9][0-9]*$/u.test(evidenceReuse.rootRunId) &&
    /^[1-9][0-9]*$/u.test(evidenceReuse.selectedRunId) &&
    evidenceReuse.sourceManifest !== null &&
    validChangedPaths
  );
}

function normalizedTrustedWorkflow(identity) {
  const ref = boundedString(identity?.ref, MAX_LABEL_LENGTH);
  const fullRef = boundedString(identity?.fullRef, MAX_LABEL_LENGTH);
  const sha = boundedString(identity?.sha, MAX_LABEL_LENGTH);
  if (
    !ref ||
    !/^[a-f0-9]{40}$/u.test(sha) ||
    (fullRef !== `refs/heads/${ref}` && fullRef !== `refs/tags/${ref}`)
  ) {
    throw new Error("release execution plan trusted workflow identity is invalid");
  }
  return { fullRef, ref, sha };
}

function executionPlanDigestPayload(plan) {
  return {
    attemptEvidenceVersion: plan.attemptEvidenceVersion,
    blockers: plan.blockers,
    children: plan.children,
    continuation: plan.continuation,
    errors: plan.errors,
    evidenceReuse: plan.evidenceReuse,
    gates: plan.gates,
    kind: plan.kind,
    parentRunAttempt: plan.parentRunAttempt,
    parentRunId: plan.parentRunId,
    releaseProfile: plan.releaseProfile,
    rerunGroup: plan.rerunGroup,
    targetSha: plan.targetSha,
    trustedWorkflow: plan.trustedWorkflow,
    version: plan.version,
    workflowRef: plan.workflowRef,
    workflowSha: plan.workflowSha,
  };
}

export function releaseExecutionPlanSha256(plan) {
  return createHash("sha256")
    .update(JSON.stringify(executionPlanDigestPayload(plan)))
    .digest("hex");
}

export function buildReleaseExecutionPlanArtifact({
  attemptEvidenceVersion,
  blockers = [],
  children,
  continuation,
  errors = [],
  evidenceReuse,
  expected,
  gates,
  releaseProfile,
  rerunGroup,
  trustedWorkflow,
}) {
  const normalizedReuse = normalizedEvidenceReuse(evidenceReuse);
  if (!validEvidenceReuseIdentity(normalizedReuse)) {
    throw new Error("release execution plan evidence reuse binding is invalid");
  }
  const normalizedPlanContinuation = normalizedContinuation(continuation);
  const normalizedChildren = children.map(normalizedPlanChild);
  if (
    normalizedPlanContinuation &&
    normalizedChildren
      .filter((child) => child.selected)
      .some(
        (child) =>
          !/^[1-9][0-9]*$/u.test(child.runId) ||
          child.runAttempt === null ||
          child.sourceParentAttempt === null ||
          child.sourceParentAttempt > normalizedPlanContinuation.sourceRunAttempt ||
          !child.workflowRef ||
          !SHA_PATTERN.test(child.workflowSha),
      )
  ) {
    throw new Error("release execution plan continuation child binding is invalid");
  }
  if (
    normalizedPlanContinuation?.candidate?.packageSourceSha !== undefined &&
    normalizedPlanContinuation.candidate.packageSourceSha !== expected.targetSha
  ) {
    throw new Error("release execution plan continuation candidate target is invalid");
  }
  if (
    normalizedPlanContinuation &&
    (normalizedPlanContinuation.releaseProfile !== releaseProfile ||
      normalizedPlanContinuation.rerunGroup !== rerunGroup ||
      normalizedPlanContinuation.toolingSha !== expected.workflowSha)
  ) {
    throw new Error("release execution plan continuation inputs are invalid");
  }
  const plan = {
    version: 1,
    kind: "openclaw.full-release-execution-plan",
    attemptEvidenceVersion:
      attemptEvidenceVersion === undefined ? undefined : Number(attemptEvidenceVersion),
    parentRunId: String(expected.parentRunId),
    parentRunAttempt: positiveInteger(expected.parentRunAttempt),
    workflowRef: boundedString(expected.workflowRef, MAX_LABEL_LENGTH),
    workflowSha: boundedString(expected.workflowSha, MAX_LABEL_LENGTH),
    targetSha: boundedString(expected.targetSha, MAX_LABEL_LENGTH),
    trustedWorkflow: normalizedTrustedWorkflow(trustedWorkflow),
    continuation: normalizedPlanContinuation,
    releaseProfile: boundedString(releaseProfile, MAX_LABEL_LENGTH),
    rerunGroup: boundedString(rerunGroup, MAX_LABEL_LENGTH),
    evidenceReuse: normalizedReuse,
    gates: gates.map(normalizedGate),
    children: normalizedChildren,
    blockers: normalizeIssues(blockers, "release_blocker"),
    errors: normalizeIssues(errors, "orchestration_error"),
  };
  if (plan.attemptEvidenceVersion !== undefined && plan.attemptEvidenceVersion !== 1) {
    throw new Error("release execution plan attempt evidence version is invalid");
  }
  return { ...plan, sha256: releaseExecutionPlanSha256(plan) };
}

export function validateReleaseExecutionPlanArtifact(payload, expected = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release execution plan artifact is invalid");
  }
  if (
    payload.version !== 1 ||
    payload.kind !== "openclaw.full-release-execution-plan" ||
    !/^[1-9][0-9]*$/u.test(String(payload.parentRunId ?? "")) ||
    positiveInteger(payload.parentRunAttempt) === undefined ||
    !/^[a-f0-9]{40}$/u.test(String(payload.workflowSha ?? "")) ||
    (payload.targetSha !== "" && !/^[a-f0-9]{40}$/u.test(String(payload.targetSha ?? ""))) ||
    (expected.parentRunId !== undefined &&
      String(payload.parentRunId) !== String(expected.parentRunId)) ||
    (expected.maxParentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) > Number(expected.maxParentRunAttempt)) ||
    (expected.workflowRef !== undefined && payload.workflowRef !== expected.workflowRef) ||
    (expected.workflowSha !== undefined && payload.workflowSha !== expected.workflowSha) ||
    (expected.releaseProfile !== undefined && payload.releaseProfile !== expected.releaseProfile) ||
    (expected.rerunGroup !== undefined && payload.rerunGroup !== expected.rerunGroup) ||
    (expected.targetSha !== undefined && payload.targetSha !== expected.targetSha)
  ) {
    throw new Error("release execution plan artifact binding is invalid");
  }
  const evidenceReuse = normalizedEvidenceReuse(payload.evidenceReuse);
  if (!validEvidenceReuseIdentity(evidenceReuse)) {
    throw new Error("release execution plan evidence reuse binding is invalid");
  }
  const trustedWorkflow = normalizedTrustedWorkflow(payload.trustedWorkflow);
  const continuation = normalizedContinuation(payload.continuation);
  const children = validatePlan(payload.children);
  if (
    continuation &&
    children
      .filter((child) => child.selected)
      .some(
        (child) =>
          !/^[1-9][0-9]*$/u.test(child.runId) ||
          child.runAttempt === null ||
          !child.workflowRef ||
          !SHA_PATTERN.test(child.workflowSha),
      )
  ) {
    throw new Error("release execution plan continuation child binding is invalid");
  }
  if (
    continuation?.candidate?.packageSourceSha !== undefined &&
    continuation.candidate.packageSourceSha !== payload.targetSha
  ) {
    throw new Error("release execution plan continuation candidate target is invalid");
  }
  if (
    continuation &&
    (continuation.releaseProfile !== payload.releaseProfile ||
      continuation.rerunGroup !== payload.rerunGroup ||
      continuation.toolingSha !== payload.workflowSha)
  ) {
    throw new Error("release execution plan continuation inputs are invalid");
  }
  const plan = {
    ...payload,
    attemptEvidenceVersion:
      payload.attemptEvidenceVersion === undefined
        ? undefined
        : Number(payload.attemptEvidenceVersion),
    parentRunAttempt: positiveInteger(payload.parentRunAttempt),
    parentRunId: String(payload.parentRunId),
    children,
    blockers: normalizeIssues(payload.blockers, "release_blocker"),
    errors: normalizeIssues(payload.errors, "orchestration_error"),
    evidenceReuse,
    gates: Array.isArray(payload.gates) ? payload.gates.map(normalizedGate) : [],
    continuation,
    trustedWorkflow,
  };
  if (plan.attemptEvidenceVersion !== undefined && plan.attemptEvidenceVersion !== 1) {
    throw new Error("release execution plan attempt evidence version is invalid");
  }
  const sha256 = releaseExecutionPlanSha256(plan);
  if (payload.sha256 !== sha256) {
    throw new Error("release execution plan artifact digest is invalid");
  }
  return { ...plan, sha256 };
}

function normalizeIssue(issue, fallbackKind) {
  return {
    child: boundedString(issue?.child, MAX_LABEL_LENGTH),
    conclusion: boundedString(issue?.conclusion, MAX_LABEL_LENGTH),
    job: boundedString(issue?.job, MAX_LABEL_LENGTH),
    kind: boundedString(issue?.kind, MAX_LABEL_LENGTH) || fallbackKind,
    message: boundedString(issue?.message, MAX_MESSAGE_LENGTH),
    runId: boundedString(issue?.runId, MAX_LABEL_LENGTH),
    url: boundedString(issue?.url, MAX_URL_LENGTH),
  };
}

function normalizeIssues(issues, fallbackKind) {
  return (Array.isArray(issues) ? issues : [])
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => normalizeIssue(issue, fallbackKind));
}

function isReleaseCheckJobAdvisory({ jobName, releaseProfile, workflowRef }) {
  if (
    jobName.startsWith("Run QA Lab parity lane (") ||
    jobName === "Run QA Lab parity report" ||
    jobName.startsWith("Run QA Lab runtime-pair lane (") ||
    jobName === "Verify QA Lab runtime-pair lanes" ||
    jobName === "Run QA Lab live Discord lane" ||
    jobName === "Run QA Lab live WhatsApp lane" ||
    jobName === "Run QA Lab live Slack lane"
  ) {
    return true;
  }
  if (/^tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u.test(workflowRef)) {
    return !(
      jobName === "resolve_target" ||
      jobName === "Prepare release package artifact" ||
      jobName.startsWith("install_smoke_release_checks / ") ||
      jobName === "Run package acceptance" ||
      jobName.startsWith("Run package acceptance / ")
    );
  }
  return (
    releaseProfile === "beta" &&
    (jobName.startsWith("Run package acceptance / Telegram package acceptance / ") ||
      (jobName.startsWith("Run repo/live E2E validation / ") &&
        (jobName.includes("Docker live") ||
          jobName.includes("Live media suites") ||
          jobName.includes("validate_live_provider_suites") ||
          jobName.includes("validate_release_live_cache") ||
          jobName.includes("prepare_live_test_image"))))
  );
}

function failedJobsForPolicy(child, releaseProfile, workflowRef) {
  return child.jobs.filter((job) => {
    if (
      job.status !== "completed" ||
      SUCCESSFUL_JOB_CONCLUSIONS.has(String(job.conclusion ?? ""))
    ) {
      return false;
    }
    if (child.key === "releaseChecks") {
      return !isReleaseCheckJobAdvisory({
        jobName: stringValue(job.name),
        releaseProfile,
        workflowRef,
      });
    }
    return !(child.key === "productPerformance" && releaseProfile === "beta");
  });
}

export function terminalPolicyPass(child, releaseProfile, workflowRef) {
  if (child.status !== "completed") {
    return false;
  }
  if (child.conclusion === "success") {
    return true;
  }
  if (child.key === "productPerformance" && releaseProfile === "beta") {
    return true;
  }
  if (child.key === "releaseChecks") {
    const verifier = child.jobs.find((job) => job.name === "Verify release checks");
    return (
      verifier?.status === "completed" &&
      verifier.conclusion === "success" &&
      failedJobsForPolicy(child, releaseProfile, workflowRef).length === 0
    );
  }
  return false;
}

function dispatchMissingBlockers(children) {
  return children
    .filter(
      (child) =>
        child.required &&
        child.selected &&
        (!/^[1-9][0-9]*$/u.test(String(child.runId ?? "")) ||
          positiveInteger(child.runAttempt) === undefined),
    )
    .map((child) => ({
      child: child.key,
      conclusion: stringValue(child.result, "missing"),
      job: child.dispatchName || `Dispatch ${child.key}`,
      kind: "dispatch_missing",
      message: `${child.key} required dispatch did not record an exact run ID and attempt`,
      runId: stringValue(child.runId),
      url: stringValue(child.url),
    }));
}

function dispatchResultBlockers(children) {
  return children
    .filter(
      (child) =>
        child.required && child.selected && child.source === "fresh" && child.result !== "success",
    )
    .map((child) => ({
      child: child.key,
      conclusion: stringValue(child.result, "missing"),
      job: child.dispatchName || `Dispatch ${child.key}`,
      kind: "dispatch_failed",
      message: `${child.key} required dispatch ended with ${stringValue(child.result, "missing")}`,
      runId: stringValue(child.runId),
      url: stringValue(child.url),
    }));
}

function releaseState(cancelled, activeRunIds, blockers, errors) {
  const active = activeRunIds.length > 0;
  return (
    (cancelled && active && "cancelled_with_children") ||
    (errors.length > 0 && "orchestration_error") ||
    (blockers.length > 0 && (active ? "blocked_diagnostics_running" : "blocked_complete")) ||
    (active ? "qualifying" : "passed")
  );
}

export function classifyReleaseSnapshot({
  cancelled = false,
  children,
  extraBlockers = [],
  extraErrors = [],
  localFailures = [],
  releaseProfile,
  workflowRef,
}) {
  const selected = children.filter((child) => child.selected);
  const active = selected.filter(
    (child) => child.runId && child.runAttempt && child.status !== "completed",
  );
  const childErrors = selected.flatMap((child) =>
    (child.errors ?? []).filter((error) => error.kind !== "dispatch_missing"),
  );
  const childJobBlockers = selected.flatMap((child) =>
    failedJobsForPolicy(child, releaseProfile, workflowRef).map((job) => ({
      child: child.key,
      conclusion: job.conclusion,
      job: job.name,
      kind: "job_failure",
      message: `${child.key} job failed policy`,
      runId: child.runId,
      url: job.html_url ?? job.url ?? child.url,
    })),
  );
  const childJobBlockerKeys = new Set(
    childJobBlockers.map((blocker) => `${blocker.child}:${blocker.runId}`),
  );
  const terminalBlockers = selected
    .filter(
      (child) =>
        child.runId &&
        child.runAttempt &&
        child.status === "completed" &&
        !terminalPolicyPass(child, releaseProfile, workflowRef) &&
        !childJobBlockerKeys.has(`${child.key}:${child.runId}`),
    )
    .map((child) => ({
      child: child.key,
      conclusion: child.conclusion,
      job: "<workflow>",
      kind: "workflow_failure",
      message: `${child.key} workflow failed release policy`,
      runId: child.runId,
      url: child.url,
    }));
  const blockers = normalizeIssues(
    [
      ...localFailures,
      ...extraBlockers,
      ...dispatchMissingBlockers(selected),
      ...dispatchResultBlockers(selected),
      ...childJobBlockers,
      ...terminalBlockers,
    ],
    "release_blocker",
  );
  const errors = normalizeIssues([...extraErrors, ...childErrors], "orchestration_error");

  const activeRunIds = active.map((child) => String(child.runId)).toSorted();
  return {
    activeRunIds,
    blockers,
    errors,
    state: releaseState(cancelled, activeRunIds, blockers, errors),
  };
}

function childTiming(child) {
  const started = Date.parse(child.createdAt);
  const updated = Date.parse(child.updatedAt);
  return {
    durationMinutes:
      Number.isFinite(started) && Number.isFinite(updated)
        ? Math.round(((updated - started) / 60_000) * 10) / 10
        : null,
    jobs: child.jobs.map((job) => {
      const startedAt = stringValue(job.started_at ?? job.startedAt);
      const completedAt = stringValue(job.completed_at ?? job.completedAt);
      const jobStarted = Date.parse(startedAt);
      const jobCompleted = Date.parse(completedAt);
      return {
        acceptedRunAttempt: positiveInteger(job.acceptedRunAttempt),
        completedAt,
        conclusion: stringValue(job.conclusion),
        durationMinutes:
          Number.isFinite(jobStarted) && Number.isFinite(jobCompleted)
            ? Math.round(((jobCompleted - jobStarted) / 60_000) * 10) / 10
            : null,
        name: boundedString(job.name, MAX_LABEL_LENGTH),
        startedAt,
        status: stringValue(job.status),
        url: boundedString(job.html_url ?? job.url, MAX_URL_LENGTH),
      };
    }),
  };
}

function normalizedPlanChild(child) {
  return {
    dispatchName: boundedString(child.dispatchName, MAX_LABEL_LENGTH),
    displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
    key: boundedString(child.key, MAX_LABEL_LENGTH),
    required: child.required === true,
    result: boundedString(child.result, MAX_LABEL_LENGTH),
    runAttempt: positiveInteger(child.runAttempt) ?? null,
    runId: boundedString(child.runId, MAX_LABEL_LENGTH),
    selected: child.selected === true,
    source: ["continuation", "reused"].includes(child.source) ? child.source : "fresh",
    sourceParentAttempt: positiveInteger(child.sourceParentAttempt) ?? null,
    url: boundedString(child.url, MAX_URL_LENGTH),
    workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
    workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
    workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
  };
}

export function buildReleaseStateArtifact({
  cancellation = {},
  children,
  decision,
  executionPlan,
  expected,
  mode,
  releaseProfile,
  rerunGroup,
}) {
  const activeRunIds = (decision.activeRunIds ?? []).map(String);
  if (
    activeRunIds.some((runId) => !/^[1-9][0-9]*$/u.test(runId)) ||
    new Set(activeRunIds).size !== activeRunIds.length ||
    JSON.stringify(activeRunIds) !== JSON.stringify(activeRunIds.toSorted())
  ) {
    throw new Error("release state active run IDs are malformed, duplicated, or unordered");
  }
  return {
    version: 2,
    kind:
      mode === "decision"
        ? "openclaw.full-release-decision"
        : "openclaw.full-release-diagnostic-drain",
    mode,
    parentRunId: expected.parentRunId,
    parentRunAttempt: expected.parentRunAttempt,
    sourceParentRunAttempt: executionPlan.parentRunAttempt,
    workflowRef: expected.workflowRef,
    workflowSha: expected.workflowSha,
    targetSha: expected.targetSha,
    releaseProfile,
    rerunGroup,
    executionPlanSha256: executionPlan.sha256,
    state: decision.state,
    activeRunIds,
    blockers: decision.blockers,
    errors: decision.errors,
    cancellation: {
      cancelledRunIds: [...(cancellation.cancelledRunIds ?? [])].map(String),
      requested: cancellation.requested === true,
    },
    children: Object.fromEntries(
      children
        .filter((child) => child.selected && child.runId && child.runAttempt)
        .map((child) => [
          child.key,
          {
            compositeJobsSha256: boundedString(child.compositeJobsSha256, MAX_LABEL_LENGTH),
            conclusion: stringValue(child.conclusion),
            dispatchActor: boundedString(child.dispatchActor, MAX_LABEL_LENGTH),
            displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
            errors: normalizeIssues(child.errors, "orchestration_error"),
            observedRunAttempts: Array.isArray(child.observedRunAttempts)
              ? child.observedRunAttempts.map((value) => {
                  const attempt = positiveInteger(value);
                  if (attempt === undefined) {
                    throw new Error(`release state child attempt is invalid: ${child.key}`);
                  }
                  return attempt;
                })
              : [],
            plannedRunAttempt: positiveInteger(child.plannedRunAttempt ?? child.runAttempt),
            runAttempt: positiveInteger(child.runAttempt),
            runId: String(child.runId),
            repository: boundedString(child.repository, MAX_LABEL_LENGTH),
            status: stringValue(child.status),
            timing: childTiming(child),
            url: boundedString(child.url, MAX_URL_LENGTH),
            workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
            workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
            workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
            triggeringActor: boundedString(child.triggeringActor, MAX_LABEL_LENGTH),
          },
        ]),
    ),
  };
}

function validatePlan(value) {
  if (!Array.isArray(value)) {
    throw new Error("release state plan is invalid");
  }
  const keys = new Set();
  return value.map((child) => {
    const normalized = normalizedPlanChild(child);
    if (
      !normalized.key ||
      !normalized.workflow ||
      !normalized.displayTitle ||
      !normalized.dispatchName ||
      keys.has(normalized.key) ||
      (normalized.required && !normalized.selected)
    ) {
      throw new Error("release state child plan is invalid");
    }
    keys.add(normalized.key);
    return normalized;
  });
}

export function validateReleaseStateArtifact(payload, expected, expectedMode) {
  const expectedValues = expected ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("release state artifact is invalid");
  }
  const mode = expectedMode ?? payload.mode;
  const expectedKind =
    mode === "decision"
      ? "openclaw.full-release-decision"
      : "openclaw.full-release-diagnostic-drain";
  if (
    payload.version !== 2 ||
    payload.mode !== mode ||
    payload.kind !== expectedKind ||
    !RELEASE_DECISION_STATE_SET.has(stringValue(payload.state)) ||
    typeof payload.cancellation?.requested !== "boolean" ||
    !Array.isArray(payload.cancellation?.cancelledRunIds) ||
    !/^[a-f0-9]{64}$/u.test(String(payload.executionPlanSha256 ?? "")) ||
    positiveInteger(payload.parentRunAttempt) === undefined ||
    positiveInteger(payload.sourceParentRunAttempt) === undefined ||
    (expectedValues.parentRunId !== undefined &&
      String(payload.parentRunId) !== String(expectedValues.parentRunId)) ||
    (expectedValues.parentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) !== Number(expectedValues.parentRunAttempt)) ||
    (expectedValues.maxParentRunAttempt !== undefined &&
      Number(payload.parentRunAttempt) > Number(expectedValues.maxParentRunAttempt)) ||
    (expectedValues.workflowRef !== undefined &&
      payload.workflowRef !== expectedValues.workflowRef) ||
    (expectedValues.workflowSha !== undefined &&
      payload.workflowSha !== expectedValues.workflowSha) ||
    (expectedValues.targetSha !== undefined && payload.targetSha !== expectedValues.targetSha) ||
    (expectedValues.releaseProfile !== undefined &&
      payload.releaseProfile !== expectedValues.releaseProfile) ||
    (expectedValues.rerunGroup !== undefined && payload.rerunGroup !== expectedValues.rerunGroup)
  ) {
    throw new Error("release state artifact binding is invalid");
  }
  const blockers = normalizeIssues(payload.blockers, "release_blocker");
  const errors = normalizeIssues(payload.errors, "orchestration_error");
  if (!Array.isArray(payload.activeRunIds)) {
    throw new Error("release state active run IDs are invalid");
  }
  const activeRunIds = payload.activeRunIds.map(String);
  if (
    activeRunIds.some((runId) => !/^[1-9][0-9]*$/u.test(runId)) ||
    new Set(activeRunIds).size !== activeRunIds.length ||
    JSON.stringify(activeRunIds) !== JSON.stringify(activeRunIds.toSorted())
  ) {
    throw new Error("release state active run IDs are malformed, duplicated, or unordered");
  }
  const children =
    payload.children && typeof payload.children === "object" && !Array.isArray(payload.children)
      ? Object.fromEntries(
          Object.entries(payload.children).map(([key, child]) => {
            if (!child || typeof child !== "object" || Array.isArray(child)) {
              throw new Error(`release state child snapshot is invalid: ${key}`);
            }
            if (!Array.isArray(child.timing?.jobs)) {
              throw new Error(`release state child jobs are invalid: ${key}`);
            }
            const plannedRunAttempt = positiveInteger(child.plannedRunAttempt);
            const runAttempt = positiveInteger(child.runAttempt);
            const observedRunAttempts = Array.isArray(child.observedRunAttempts)
              ? child.observedRunAttempts.map((value) => positiveInteger(value))
              : undefined;
            const expectedRunAttempts =
              plannedRunAttempt === undefined || runAttempt === undefined
                ? []
                : Array.from(
                    { length: runAttempt - plannedRunAttempt + 1 },
                    (_, index) => plannedRunAttempt + index,
                  );
            if (
              (child.compositeJobsSha256 || (observedRunAttempts?.length ?? 0) > 0) &&
              (plannedRunAttempt === undefined ||
                runAttempt === undefined ||
                !observedRunAttempts ||
                observedRunAttempts.some((value) => value === undefined) ||
                JSON.stringify(observedRunAttempts) !== JSON.stringify(expectedRunAttempts))
            ) {
              throw new Error(`release state child attempt evidence is invalid: ${key}`);
            }
            const timingJobs = child.timing.jobs.map((job) => ({
              acceptedRunAttempt: positiveInteger(job?.acceptedRunAttempt),
              completedAt: stringValue(job?.completedAt),
              conclusion: stringValue(job?.conclusion),
              durationMinutes:
                typeof job?.durationMinutes === "number" ? job.durationMinutes : null,
              name: boundedString(job?.name, MAX_LABEL_LENGTH),
              startedAt: stringValue(job?.startedAt),
              status: stringValue(job?.status),
              url: boundedString(job?.url, MAX_URL_LENGTH),
            }));
            const jobNames = timingJobs.map((job) => job.name);
            if (
              child.compositeJobsSha256 &&
              (timingJobs.length === 0 ||
                timingJobs.some(
                  (job) =>
                    !job.name ||
                    job.acceptedRunAttempt === undefined ||
                    job.acceptedRunAttempt < plannedRunAttempt ||
                    job.acceptedRunAttempt > runAttempt,
                ) ||
                new Set(jobNames).size !== jobNames.length ||
                JSON.stringify(jobNames) !== JSON.stringify(jobNames.toSorted()))
            ) {
              throw new Error(`release state child composite jobs are invalid: ${key}`);
            }
            return [
              key,
              {
                compositeJobsSha256: boundedString(child.compositeJobsSha256, MAX_LABEL_LENGTH),
                conclusion: stringValue(child.conclusion),
                dispatchActor: boundedString(child.dispatchActor, MAX_LABEL_LENGTH),
                displayTitle: boundedString(child.displayTitle, MAX_LABEL_LENGTH),
                errors: normalizeIssues(child.errors, "orchestration_error"),
                observedRunAttempts: observedRunAttempts ?? [],
                plannedRunAttempt,
                runAttempt,
                runId: String(child.runId ?? ""),
                repository: boundedString(child.repository, MAX_LABEL_LENGTH),
                status: stringValue(child.status),
                timing: {
                  durationMinutes:
                    typeof child.timing?.durationMinutes === "number"
                      ? child.timing.durationMinutes
                      : null,
                  jobs: timingJobs,
                },
                url: boundedString(child.url, MAX_URL_LENGTH),
                workflow: boundedString(child.workflow, MAX_LABEL_LENGTH),
                workflowRef: boundedString(child.workflowRef, MAX_LABEL_LENGTH),
                workflowSha: boundedString(child.workflowSha, MAX_LABEL_LENGTH),
                triggeringActor: boundedString(child.triggeringActor, MAX_LABEL_LENGTH),
              },
            ];
          }),
        )
      : {};
  return {
    ...payload,
    activeRunIds,
    blockers,
    children,
    errors,
    parentRunAttempt: positiveInteger(payload.parentRunAttempt),
    sourceParentRunAttempt: positiveInteger(payload.sourceParentRunAttempt),
  };
}

export function releasePlanGateFailures(gates) {
  return gates
    .filter((gate) => gate.required && gate.result !== "success")
    .map((gate) => ({
      child: "<parent>",
      conclusion: stringValue(gate.result, "missing"),
      job: stringValue(gate.name, "parent gate"),
      kind: "parent_gate_failure",
      message: `${stringValue(gate.name, "parent gate")} did not succeed`,
    }));
}

export function releaseStateChildEvidence(child) {
  return canonicalValue({
    compositeJobsSha256: child.compositeJobsSha256,
    conclusion: child.conclusion,
    dispatchActor: child.dispatchActor,
    effectiveRunAttempt: child.runAttempt,
    jobs: child.timing.jobs.map((job) => ({
      acceptedRunAttempt: job.acceptedRunAttempt,
      completedAt: job.completedAt,
      conclusion: job.conclusion,
      name: job.name,
      startedAt: job.startedAt,
      status: job.status,
      url: job.url,
    })),
    observedRunAttempts: child.observedRunAttempts,
    plannedRunAttempt: child.plannedRunAttempt,
    repository: child.repository,
    runId: child.runId,
    status: child.status,
    triggeringActor: child.triggeringActor,
    workflow: child.workflow,
    workflowRef: child.workflowRef,
    workflowSha: child.workflowSha,
  });
}

function verifyStateStructure(state, executionPlan, label) {
  const selected = executionPlan.children.filter((entry) => entry.selected);
  const expectedKeys = selected.map((child) => child.key).toSorted();
  if (JSON.stringify(Object.keys(state.children).toSorted()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} child set differs from the immutable execution plan`);
  }
  const snapshots = selected.map((child) => {
    if (!child.runId || !child.runAttempt) {
      throw new Error(`selected release child omitted exact identity: ${child.key}`);
    }
    const snapshot = state.children[child.key];
    if (
      !snapshot ||
      snapshot.runId !== child.runId ||
      snapshot.plannedRunAttempt !== child.runAttempt ||
      snapshot.runAttempt < child.runAttempt ||
      snapshot.displayTitle !== child.displayTitle ||
      snapshot.workflow !== child.workflow ||
      snapshot.workflowRef !== child.workflowRef ||
      snapshot.workflowSha !== child.workflowSha
    ) {
      throw new Error(`${label} child provenance differs from the immutable plan: ${child.key}`);
    }
    if (executionPlan.attemptEvidenceVersion === 1) {
      if (
        snapshot.dispatchActor !== "github-actions[bot]" ||
        !snapshot.triggeringActor ||
        !snapshot.repository
      ) {
        throw new Error(`${label} child rerun provenance is invalid: ${child.key}`);
      }
      const expectedAttempts = Array.from(
        { length: snapshot.runAttempt - child.runAttempt + 1 },
        (_, index) => child.runAttempt + index,
      );
      if (JSON.stringify(snapshot.observedRunAttempts) !== JSON.stringify(expectedAttempts)) {
        throw new Error(`${label} child attempt evidence is gapped: ${child.key}`);
      }
      const composite = {
        effectiveRunAttempt: snapshot.runAttempt,
        jobs: snapshot.timing.jobs.map((job) => {
          const acceptedRunAttempt = positiveInteger(job.acceptedRunAttempt);
          if (
            acceptedRunAttempt === undefined ||
            acceptedRunAttempt < child.runAttempt ||
            acceptedRunAttempt > snapshot.runAttempt
          ) {
            throw new Error(`${label} child job attempt is invalid: ${child.key}`);
          }
          return {
            acceptedRunAttempt,
            completedAt: job.completedAt,
            conclusion: job.conclusion,
            name: job.name,
            startedAt: job.startedAt,
            status: job.status,
            url: job.url,
          };
        }),
        plannedRunAttempt: child.runAttempt,
      };
      if (
        snapshot.compositeJobsSha256 !== releaseCompositeJobsSha256(composite) ||
        new Set(composite.jobs.map((job) => job.name)).size !== composite.jobs.length
      ) {
        throw new Error(`${label} child composite job evidence is invalid: ${child.key}`);
      }
    }
    return Object.assign({}, child, snapshot, {
      jobs: snapshot.timing.jobs.map((job) => ({
        conclusion: job.conclusion,
        html_url: job.url,
        name: job.name,
        status: job.status,
        url: job.url,
      })),
    });
  });
  const { cancelledRunIds, requested } = state.cancellation;
  const affectedRunIds = new Set(affectedActiveRunIds(snapshots, state.blockers));
  if (
    (requested &&
      !state.errors.some(
        ({ child, kind }) => child === "<collector>" && kind === "collector_cancelled",
      )) ||
    new Set(cancelledRunIds).size !== cancelledRunIds.length ||
    cancelledRunIds.some((runId) => !/^[1-9][0-9]*$/u.test(runId) || !affectedRunIds.has(runId))
  ) {
    throw new Error(`${label} cancellation differs from exact child state`);
  }
  const baseline = classifyReleaseSnapshot({
    children: snapshots,
    extraBlockers: executionPlan.blockers,
    extraErrors: executionPlan.errors,
    localFailures: releasePlanGateFailures(executionPlan.gates),
    releaseProfile: executionPlan.releaseProfile,
    workflowRef: executionPlan.workflowRef,
  });
  if (JSON.stringify(state.activeRunIds) !== JSON.stringify(baseline.activeRunIds)) {
    throw new Error(`${label} activeRunIds differs from canonical release policy`);
  }
  for (const key of ["blockers", "errors"]) {
    const claimed = new Set(state[key].map((issue) => JSON.stringify(issue)));
    if (baseline[key].some((issue) => !claimed.has(JSON.stringify(issue)))) {
      throw new Error(`${label} omits baseline ${key}`);
    }
  }
  if (releaseState(requested, state.activeRunIds, state.blockers, state.errors) !== state.state) {
    throw new Error(`${label} state differs from canonical release policy`);
  }
}

function verifyStateTransition(decision, drain) {
  const reuseRecovery =
    ["blocked_complete", "blocked_diagnostics_running"].includes(decision.state) &&
    drain.state === "passed" &&
    decision.errors.length === 0 &&
    decision.blockers.length > 0 &&
    decision.blockers.every(
      ({ child, kind }) =>
        child === "<evidence>" && ["reused_evidence_invalid", "provenance_mismatch"].includes(kind),
    );
  if (
    ["qualifying", "blocked_diagnostics_running"].includes(drain.state) ||
    decision.state === "qualifying" ||
    (decision.state === "passed" && drain.state === "blocked_complete") ||
    (decision.state.startsWith("blocked_") && drain.state === "passed" && !reuseRecovery)
  ) {
    throw new Error("release decision and diagnostic drain transition is invalid");
  }
  if (
    decision.state.startsWith("blocked_") &&
    drain.state === "blocked_complete" &&
    !decision.blockers.every((blocker) =>
      drain.blockers.some(
        (candidate) =>
          JSON.stringify(candidate) === JSON.stringify(blocker) ||
          (blocker.kind === "workflow_failure" &&
            candidate.kind === "job_failure" &&
            ["child", "runId"].every((key) => candidate[key] === blocker[key])),
      ),
    )
  ) {
    throw new Error("diagnostic drain changed or removed a release decision blocker");
  }
}

function verifyReleaseStatePair(planPayload, decisionPayload, drainPayload, expected = {}) {
  const executionPlan = validateReleaseExecutionPlanArtifact(planPayload, expected);
  const decision = validateReleaseStateArtifact(decisionPayload, expected, "decision");
  const drain = validateReleaseStateArtifact(drainPayload, expected, "drain");
  if (
    decision.executionPlanSha256 !== executionPlan.sha256 ||
    drain.executionPlanSha256 !== executionPlan.sha256 ||
    decision.sourceParentRunAttempt !== executionPlan.parentRunAttempt ||
    drain.sourceParentRunAttempt !== executionPlan.parentRunAttempt
  ) {
    throw new Error("release decision and diagnostic drain execution plans differ");
  }
  verifyStateStructure(decision, executionPlan, "release decision");
  verifyStateStructure(drain, executionPlan, "diagnostic drain");
  verifyStateTransition(decision, drain);
  return {
    decision,
    drain,
    executionPlan,
    sourceAttempts: {
      decision: decision.parentRunAttempt,
      drain: drain.parentRunAttempt,
      executionPlan: executionPlan.parentRunAttempt,
    },
  };
}

export function verifyReleaseStateArtifacts(plan, decision, drain, expected = {}) {
  const verified = verifyReleaseStatePair(plan, decision, drain, expected);
  if (verified.decision.state !== "passed" || verified.drain.state !== "passed") {
    const outcome = verified.drain.state === "passed" ? verified.decision : verified.drain;
    throw new Error(formatReleaseStateOutcome(outcome));
  }
  for (const child of verified.executionPlan.children.filter((entry) => entry.selected)) {
    if (
      JSON.stringify(releaseStateChildEvidence(verified.decision.children[child.key])) !==
      JSON.stringify(releaseStateChildEvidence(verified.drain.children[child.key]))
    ) {
      throw new Error(`release decision and diagnostic drain child evidence differ: ${child.key}`);
    }
  }
  return verified;
}

function newestStateCandidate(candidates, mode, runId, expected) {
  const prefix = mode === "decision" ? "full-release-decision" : "full-release-diagnostics";
  const pattern = new RegExp(`^${prefix}-${runId}-([1-9][0-9]*)$`, "u");
  const maxParentRunAttempt = Number(expected.maxParentRunAttempt ?? Number.POSITIVE_INFINITY);
  const sorted = candidates
    .map((candidate) => {
      const match = pattern.exec(String(candidate.name ?? ""));
      return match ? { ...candidate, attempt: Number(match[1]) } : undefined;
    })
    .filter(Boolean)
    .filter((candidate) => candidate.attempt <= maxParentRunAttempt)
    .toSorted((left, right) => right.attempt - left.attempt);
  const newest = sorted[0];
  if (!newest) {
    throw new Error(`no ${mode} artifact exists at or before the current parent attempt`);
  }
  const payload = validateReleaseStateArtifact(newest.payload, expected, mode);
  if (payload.parentRunAttempt !== newest.attempt) {
    throw new Error(`${mode} artifact name and source attempt differ`);
  }
  return payload;
}

export function selectReleaseStateArtifacts(
  executionPlanPayload,
  decisionCandidates,
  drainCandidates,
  expected = {},
) {
  const executionPlan = validateReleaseExecutionPlanArtifact(executionPlanPayload, expected);
  const selectionExpected = {
    ...expected,
    parentRunAttempt: undefined,
  };
  const decision = newestStateCandidate(
    decisionCandidates,
    "decision",
    executionPlan.parentRunId,
    selectionExpected,
  );
  const drain = newestStateCandidate(
    drainCandidates,
    "drain",
    executionPlan.parentRunId,
    selectionExpected,
  );
  return verifyReleaseStatePair(executionPlan, decision, drain, selectionExpected);
}

function issueSummary(prefix, issue) {
  const label =
    issue.job || issue.message || issue.child || issue.kind || `${prefix.toLowerCase()} detail`;
  const result = issue.conclusion ? ` (${issue.conclusion})` : "";
  const url = issue.url ? ` ${issue.url}` : "";
  return `- ${prefix}: ${label}${result}${url}`;
}

function releaseStateDetailLines(payload, maxItems = MAX_SUMMARY_ISSUES) {
  const normalizedMax = Math.max(1, Math.min(maxItems || MAX_SUMMARY_ISSUES, 10));
  const lines = [];
  for (const blocker of payload.blockers.slice(0, normalizedMax)) {
    lines.push(issueSummary("Blocker", blocker));
  }
  for (const error of payload.errors.slice(0, normalizedMax)) {
    lines.push(issueSummary("Collector error", error));
  }
  const omitted =
    Math.max(0, payload.blockers.length - normalizedMax) +
    Math.max(0, payload.errors.length - normalizedMax);
  if (omitted > 0) {
    lines.push(`- ${omitted} additional blocker/error item(s) omitted`);
  }
  return lines;
}

export function formatReleaseStateOutcome(payload) {
  const lines = [`Full Release Validation state: ${payload.state}`];
  lines.push(...releaseStateDetailLines(payload));
  if (payload.state === "blocked_diagnostics_running") {
    lines.push(
      "Diagnostic Drain is still collecting terminal evidence; diagnose now, retry later.",
    );
  } else if (payload.state === "orchestration_error") {
    lines.push("Recover the collector against the same exact child runs; do not redispatch tests.");
  } else if (payload.state === "cancelled_with_children") {
    lines.push("The collector stopped while exact child runs remained active.");
  }
  return lines.join("\n");
}

export function affectedActiveRunIds(children, blockers, cancelledRunIds = new Set()) {
  const affected = new Set(
    blockers.map((blocker) => String(blocker.runId ?? "")).filter((runId) => runId),
  );
  return children
    .filter(
      (child) =>
        child.status !== "completed" &&
        affected.has(String(child.runId)) &&
        !cancelledRunIds.has(String(child.runId)),
    )
    .map((child) => String(child.runId));
}

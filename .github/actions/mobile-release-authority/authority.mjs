#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  mobileReleaseRefForIntent,
  readMobileReleaseIntent,
} from "../../../scripts/mobile-release-intent.mjs";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const actionPath = process.env.MOBILE_ACTION_PATH ?? "";
const trustedRoot = path.resolve(actionPath, "../../..");
const platform = process.env.MOBILE_PLATFORM ?? "";
const operation = process.env.MOBILE_OPERATION ?? "";
const workflowPath = process.env.MOBILE_WORKFLOW_PATH ?? "";
const workflowFullRef = process.env.MOBILE_WORKFLOW_FULL_REF ?? "";
const workflowSha = process.env.MOBILE_WORKFLOW_SHA ?? "";
const targetRef = process.env.MOBILE_TARGET_REF ?? "";
const targetSha = process.env.MOBILE_TARGET_SHA ?? "";
const authorityRunId = process.env.MOBILE_AUTHORITY_RUN_ID ?? "";
const actor = process.env.MOBILE_ACTOR ?? "";
const triggeringActor = process.env.MOBILE_TRIGGERING_ACTOR ?? "";
const recovery = process.env.MOBILE_RECOVERY === "true";
const receiptArtifactId = process.env.MOBILE_RECEIPT_ARTIFACT_ID ?? "";
const receiptArtifactDigest = process.env.MOBILE_RECEIPT_ARTIFACT_DIGEST ?? "";
const receiptArtifactName = process.env.MOBILE_RECEIPT_ARTIFACT_NAME ?? "";
const intentArtifactId = process.env.MOBILE_INTENT_ARTIFACT_ID ?? "";
const intentArtifactDigest = process.env.MOBILE_INTENT_ARTIFACT_DIGEST ?? "";
const intentArtifactName = process.env.MOBILE_INTENT_ARTIFACT_NAME ?? "";
const releaseRefToken = process.env.MOBILE_RELEASE_REF_TOKEN ?? "";

const workflowPaths = {
  android: ".github/workflows/android-beta-release.yml",
  ios: ".github/workflows/ios-beta-release.yml",
};
const releaseCandidatePaths = [
  "apps/mobile/version.json",
  "apps/android/version.json",
  "apps/android/Config/Version.properties",
  "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
  "apps/ios/CHANGELOG.md",
];
const releaseCandidatePathSet = new Set(releaseCandidatePaths);
const MAX_RELEASE_CANDIDATE_COMMITS = 32;
const MAX_RELEASE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024;

function fail(message) {
  throw new Error(message);
}

function output(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    fail("GITHUB_OUTPUT is required.");
  }
  fs.appendFileSync(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
    ...options,
  }).trim();
}

function runBuffer(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
    ...options,
  });
}

function gh(args) {
  return run("gh", args, {
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
    },
  });
}

function ghWithReleaseToken(args, allowFailure = false) {
  const options = {
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: releaseRefToken,
    },
  };
  if (!allowFailure) {
    return run("gh", args, options);
  }
  try {
    return run("gh", args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function git(cwd, ...args) {
  return run("git", ["-C", cwd, ...args]);
}

function gitBuffer(cwd, ...args) {
  return runBuffer("git", ["-C", cwd, ...args]);
}

function positiveDecimal(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    fail(`${name} must be a positive decimal.`);
  }
  return value;
}

function fullSha(value, name) {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    fail(`${name} must be a full lowercase commit SHA.`);
  }
  return value;
}

function canonicalReleaseRef(value) {
  const match = /^release\/(20[0-9]{2}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*)-mobile$/u.exec(value);
  if (!match) {
    fail("target-ref must be a canonical release/YYYY.M.PATCH-mobile branch.");
  }
  return match[1];
}

function canonicalDigest(value, name) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(`${name} must be a canonical sha256 digest.`);
  }
  return value;
}

function expectedWorkflowPath() {
  const expected = workflowPaths[platform];
  if (!expected) {
    fail("platform must be ios or android.");
  }
  return expected;
}

function validateTrustedWorkflow() {
  if (!["authorize", "revalidate", "record"].includes(operation)) {
    fail("operation must be authorize, revalidate, or record.");
  }
  const expectedPath = expectedWorkflowPath();
  const expectedFullRef = `${repository}/${expectedPath}@refs/heads/main`;
  if (
    repository !== "openclaw/openclaw" ||
    workflowPath !== expectedPath ||
    workflowFullRef !== expectedFullRef
  ) {
    fail("Mobile release authority must use the canonical main workflow.");
  }
  fullSha(workflowSha, "workflow-sha");
  if (git(trustedRoot, "rev-parse", "HEAD") !== workflowSha) {
    fail("Trusted mobile release authority checkout does not match workflow-sha.");
  }
  const remote = git(trustedRoot, "remote", "get-url", "origin")
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "");
  if (remote !== `https://github.com/${repository}`) {
    fail("Trusted mobile release authority checkout has an unexpected origin.");
  }
}

function runAttemptOne(runId) {
  return JSON.parse(gh(["api", `repos/${repository}/actions/runs/${runId}/attempts/1`]));
}

function runIdentity(runValue) {
  const observedPath = String(runValue.path ?? "");
  return {
    actor: runValue.actor?.login,
    event: runValue.event,
    headBranch: runValue.head_branch,
    headSha: runValue.head_sha,
    id: String(runValue.id ?? ""),
    observedPath,
    path: observedPath.split("@", 1)[0],
    runAttempt: String(runValue.run_attempt ?? ""),
    triggeringActor: runValue.triggering_actor?.login,
  };
}

function validateRunIdentity(runValue, expected, status, conclusion) {
  const actual = runIdentity(runValue);
  const comparable = { ...actual };
  delete comparable.observedPath;
  if (
    JSON.stringify(comparable) !== JSON.stringify(expected) ||
    runValue.status !== status ||
    runValue.conclusion !== conclusion ||
    (actual.observedPath.includes("@") && actual.observedPath !== `${workflowPath}@refs/heads/main`)
  ) {
    fail(`Mobile release run identity is not exact: ${JSON.stringify(actual)}`);
  }
  const timestamp = new Date(runValue.run_started_at);
  if (!Number.isFinite(timestamp.getTime())) {
    fail("Mobile release run has an invalid run_started_at.");
  }
  return timestamp.toISOString();
}

function expectedRun(params) {
  return {
    actor: params.actor,
    event: "workflow_dispatch",
    headBranch: "main",
    headSha: params.workflowSha,
    id: params.runId,
    path: workflowPath,
    runAttempt: "1",
    triggeringActor: params.triggeringActor,
  };
}

function validateDispatchLifecycle(params, status, conclusion) {
  // Dispatch inputs are immutable, but run lifecycle can change after any external validation.
  return validateRunIdentity(runAttemptOne(params.runId), expectedRun(params), status, conclusion);
}

function validateCurrentDispatchEnvironment() {
  const currentRunId = positiveDecimal(process.env.GITHUB_RUN_ID ?? "", "current run ID");
  const currentActor = process.env.GITHUB_ACTOR ?? "";
  const currentTriggeringActor = process.env.GITHUB_TRIGGERING_ACTOR ?? "";
  if (
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_SHA !== workflowSha ||
    process.env.GITHUB_WORKFLOW_REF !== workflowFullRef ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    !currentActor ||
    currentActor !== currentTriggeringActor
  ) {
    fail("Mobile beta release must be an original canonical main workflow dispatch.");
  }
  return {
    actor: currentActor,
    runId: currentRunId,
    triggeringActor: currentTriggeringActor,
    workflowSha,
  };
}

function validateCurrentDispatchLifecycle(current) {
  return validateDispatchLifecycle(current, "in_progress", null);
}

function collaboratorPermission(login) {
  const permission = gh([
    "api",
    `repos/${repository}/collaborators/${login}/permission`,
    "--jq",
    ".permission",
  ]);
  if (!["write", "maintain", "admin"].includes(permission)) {
    fail(`Mobile release actor ${login} lacks write, maintain, or admin permission.`);
  }
}

function readRef(fullRef) {
  const ref = fullRef.replace(/^refs\//u, "");
  return fullSha(
    gh(["api", `repos/${repository}/git/ref/${ref}`, "--jq", ".object.sha"]),
    `live ${fullRef}`,
  );
}

function stableReleaseRefs(expectedBase, expectedTarget, requireCurrentMain) {
  const targetFullRef = `refs/heads/${targetRef}`;
  const mainBefore = requireCurrentMain ? readRef("refs/heads/main") : null;
  const targetBefore = readRef(targetFullRef);
  if (requireCurrentMain && mainBefore !== expectedBase) {
    fail("Trusted workflow SHA is no longer the exact main branch head.");
  }
  if (targetBefore !== expectedTarget) {
    fail("Mobile release branch no longer points at the approved target SHA.");
  }
  return () => {
    const targetAfter = readRef(targetFullRef);
    if (targetAfter !== targetBefore || targetAfter !== expectedTarget) {
      fail("Mobile release branch changed during authority validation.");
    }
    if (requireCurrentMain) {
      const mainAfter = readRef("refs/heads/main");
      if (mainAfter !== mainBefore || mainAfter !== expectedBase) {
        fail("Main changed during initial mobile release authorization.");
      }
    }
  };
}

function readCandidateBlob(ref, filePath) {
  const value = gitBuffer(trustedRoot, "show", `${ref}:${filePath}`);
  if (value.byteLength > MAX_RELEASE_METADATA_BYTES) {
    fail(`${filePath}: release candidate metadata exceeds 2 MiB.`);
  }
  return value;
}

function canonicalJson(raw, filePath) {
  const source = raw.toString("utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail(`${filePath}: release candidate JSON is malformed.`);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    `${JSON.stringify(value, null, 2)}\n` !== source
  ) {
    fail(`${filePath}: release candidate JSON must be a canonical object.`);
  }
  return value;
}

function parseRawDiff(raw) {
  if (raw.byteLength === 0 || raw.at(-1) !== 0) {
    fail("Mobile release candidate raw diff is empty or malformed.");
  }
  const fields = raw.toString("utf8").split("\0");
  fields.pop();
  if (fields.length === 0 || fields.length % 2 !== 0) {
    fail("Mobile release candidate raw diff has a truncated record.");
  }
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index] ?? "";
    const filePath = fields[index + 1] ?? "";
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u.exec(header);
    if (
      !match ||
      match[1] !== "100644" ||
      match[2] !== "100644" ||
      match[5] !== "M" ||
      match[3] === match[4] ||
      !releaseCandidatePathSet.has(filePath)
    ) {
      fail(`Mobile release candidate contains a non-metadata or non-regular change: ${filePath}`);
    }
    if (paths.includes(filePath)) {
      fail(`Mobile release candidate repeats changed path ${filePath}.`);
    }
    paths.push(filePath);
  }
  if (
    paths.length !== releaseCandidatePaths.length ||
    releaseCandidatePaths.some((filePath) => !paths.includes(filePath))
  ) {
    fail("Mobile release candidate must modify exactly the five generated mobile release files.");
  }
  return paths;
}

function verifyCandidateTreeModes(baseSha, candidateSha) {
  for (const filePath of releaseCandidatePaths) {
    for (const ref of [baseSha, candidateSha]) {
      const entry = git(trustedRoot, "ls-tree", ref, "--", filePath);
      if (!new RegExp(`^100644 blob [0-9a-f]{40}\\t${filePath}$`, "u").test(entry)) {
        fail(`${filePath}: release metadata must remain a regular non-executable file.`);
      }
    }
  }
}

function writeStageBlob(rootDir, filePath, bytes) {
  const destination = path.join(rootDir, filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

function changelogHeadings(raw) {
  const source = raw.toString("utf8");
  if (source.includes("\0") || source.includes("\r") || !source.endsWith("\n")) {
    fail("apps/ios/CHANGELOG.md must be canonical LF-terminated text.");
  }
  return source
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).split(" - ", 1)[0].trim());
}

const releaseToolingPromises = new Map();
async function releaseTooling(baseSha) {
  if (!releaseToolingPromises.has(baseSha)) {
    const stage = fs.mkdtempSync(
      path.join(process.env.RUNNER_TEMP ?? path.dirname(trustedRoot), "mobile-release-tooling-"),
    );
    const archive = gitBuffer(trustedRoot, "archive", "--format=tar", baseSha, "--", "scripts");
    runBuffer("tar", ["-xf", "-", "-C", stage], {
      input: archive,
      stdio: ["pipe", "pipe", "inherit"],
    });
    releaseToolingPromises.set(
      baseSha,
      Promise.all([
        import(pathToFileURL(path.join(stage, "scripts/mobile-release-version.ts")).href),
        import(pathToFileURL(path.join(stage, "scripts/lib/ios-release-plan.ts")).href),
      ]).then(([mobile, ios]) => ({
        applyMobileReleasePlan: mobile.applyMobileReleasePlan,
        decodeIosAppStoreVersion: ios.decodeIosAppStoreVersion,
        mobileReleasePaths: mobile.MOBILE_RELEASE_PATHS,
        planMobileRelease: mobile.planMobileRelease,
      })),
    );
  }
  return releaseToolingPromises.get(baseSha);
}

async function regenerateReleaseCandidate(baseSha, candidateSha, gatewayVersion) {
  const tooling = await releaseTooling(baseSha);
  if (JSON.stringify(tooling.mobileReleasePaths) !== JSON.stringify(releaseCandidatePaths)) {
    fail("Trusted mobile cutter release path contract does not match release authority.");
  }
  const baseBlobs = new Map(
    releaseCandidatePaths.map((filePath) => [filePath, readCandidateBlob(baseSha, filePath)]),
  );
  const targetBlobs = new Map(
    releaseCandidatePaths.map((filePath) => [filePath, readCandidateBlob(candidateSha, filePath)]),
  );
  const appStoreVersions = changelogHeadings(targetBlobs.get("apps/ios/CHANGELOG.md"))
    .filter((heading) => tooling.decodeIosAppStoreVersion(gatewayVersion, heading))
    .toSorted();
  const matches = [];

  for (const appStoreVersion of appStoreVersions) {
    const decoded = tooling.decodeIosAppStoreVersion(gatewayVersion, appStoreVersion);
    if (!decoded || decoded.legacy) {
      continue;
    }
    const stage = fs.mkdtempSync(
      path.join(process.env.RUNNER_TEMP ?? path.dirname(trustedRoot), "mobile-release-candidate-"),
    );
    try {
      for (const [filePath, bytes] of baseBlobs) {
        writeStageBlob(stage, filePath, bytes);
      }
      const prepare = tooling.planMobileRelease({
        gatewayVersion,
        phase: "prepare",
        rootDir: stage,
      });
      tooling.applyMobileReleasePlan(prepare);
      const finalize = tooling.planMobileRelease({
        gatewayVersion,
        iosPlan: {
          appStoreRevision: decoded.revision,
          appStoreVersion,
          appStoreVersionId: null,
          appStoreVersionState: null,
          buildNumber: 1,
          buildUploads: [],
          changelogStatus: "needs-cut",
          decision: "new-revision",
          gatewayVersion,
          sourceClean: true,
          sourceSha: candidateSha,
        },
        phase: "finalize",
        rootDir: stage,
      });
      tooling.applyMobileReleasePlan(finalize);
      const matchesTarget = releaseCandidatePaths.every((filePath) =>
        fs.readFileSync(path.join(stage, filePath)).equals(targetBlobs.get(filePath)),
      );
      if (matchesTarget) {
        matches.push({
          androidPhoneVersionCode: String(finalize.androidVersionCode),
          androidVersionName: gatewayVersion,
          androidWearVersionCode: String(finalize.wearVersionCode),
          iosAppStoreVersion: appStoreVersion,
        });
      }
    } catch {
      // Each candidate heading is independently regenerated; only exact output parity is authority.
    } finally {
      fs.rmSync(stage, { force: true, recursive: true });
    }
  }
  if (matches.length !== 1) {
    fail("Mobile release candidate does not byte-match one trusted five-file cutter plan.");
  }
  return matches[0];
}

async function validateReleaseCandidate(baseSha) {
  const gatewayVersion = canonicalReleaseRef(targetRef);
  git(
    trustedRoot,
    "fetch",
    "--no-tags",
    "--depth=256",
    "origin",
    "+refs/heads/main:refs/remotes/origin/mobile-authority-main",
    `+refs/heads/${targetRef}:refs/remotes/origin/mobile-authority-target`,
  );
  if (git(trustedRoot, "rev-parse", "refs/remotes/origin/mobile-authority-target") !== targetSha) {
    fail("Fetched release branch does not match target-sha.");
  }
  git(trustedRoot, "cat-file", "-e", `${baseSha}^{commit}`);
  if (git(trustedRoot, "merge-base", baseSha, targetSha) !== baseSha) {
    fail("Mobile release candidate must descend from its pinned trusted workflow base.");
  }
  const commits = git(trustedRoot, "rev-list", "--parents", "--reverse", `${baseSha}..${targetSha}`)
    .split("\n")
    .filter(Boolean);
  if (
    commits.length < 1 ||
    commits.length > MAX_RELEASE_CANDIDATE_COMMITS ||
    commits.some((line) => line.split(" ").length !== 2)
  ) {
    fail("Mobile release candidate history must be a bounded linear commit chain.");
  }
  parseRawDiff(
    gitBuffer(
      trustedRoot,
      "diff",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      baseSha,
      targetSha,
      "--",
    ),
  );
  verifyCandidateTreeModes(baseSha, targetSha);
  const manifest = canonicalJson(
    readCandidateBlob(targetSha, "apps/mobile/version.json"),
    "apps/mobile/version.json",
  );
  if (
    JSON.stringify(Object.keys(manifest)) !== JSON.stringify(["version"]) ||
    manifest.version !== gatewayVersion
  ) {
    fail("apps/mobile/version.json must exactly match the mobile release branch version.");
  }
  return {
    gatewayVersion,
    ...(await regenerateReleaseCandidate(baseSha, targetSha, gatewayVersion)),
  };
}

async function validateStableReleaseCandidate(baseSha, requireCurrentMain) {
  const verifyStable = stableReleaseRefs(baseSha, targetSha, requireCurrentMain);
  const candidate = await validateReleaseCandidate(baseSha);
  verifyStable();
  return candidate;
}

function validateTargetInputs() {
  canonicalReleaseRef(targetRef);
  fullSha(targetSha, "target-sha");
  positiveDecimal(authorityRunId, "authority-run-id");
  if (recovery && operation !== "record") {
    fail("Record-only recovery is valid only for the record operation.");
  }
}

function receiptDirectory() {
  return path.join(process.env.RUNNER_TEMP, `mobile-release-ref-${platform}`);
}

function receiptPath() {
  return path.join(receiptDirectory(), "receipt.json");
}

function intentDirectory() {
  return path.join(process.env.RUNNER_TEMP, `mobile-release-intent-${platform}`);
}

function intentPath() {
  return path.join(intentDirectory(), "intent.json");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function exactReceiptKeys(receipt) {
  const expected = [
    "actor",
    "androidPhoneVersionCode",
    "androidVersionName",
    "androidWearVersionCode",
    "buildTimestamp",
    "gatewayVersion",
    "iosAppStoreVersion",
    "kind",
    "platform",
    "repository",
    "runAttempt",
    "runId",
    "schemaVersion",
    "targetRef",
    "targetSha",
    "triggeringActor",
    "workflowFullRef",
    "workflowPath",
    "workflowSha",
  ];
  if (JSON.stringify(Object.keys(receipt).toSorted()) !== JSON.stringify(expected)) {
    fail("Mobile release authority receipt has an unexpected shape.");
  }
}

function strictArtifactFile(directory, filename, maxBytes) {
  const entries = fs.readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== filename) {
    fail(`Downloaded mobile release artifact must contain only ${filename}.`);
  }
  const file = path.join(directory, filename);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
    fail(`${filename} must be a bounded regular file.`);
  }
  return file;
}

function artifactByName(runId, name) {
  const response = JSON.parse(
    gh(["api", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]),
  );
  const matches = (response.artifacts ?? []).filter(
    (artifact) => artifact.name === name && artifact.expired === false,
  );
  if (matches.length !== 1) {
    fail(`Expected exactly one unexpired ${name} artifact.`);
  }
  const artifact = matches[0];
  const id = positiveDecimal(String(artifact.id ?? ""), `${name} artifact ID`);
  const digest = canonicalDigest(String(artifact.digest ?? ""), `${name} artifact digest`);
  if (String(artifact.workflow_run?.id ?? "") !== runId) {
    fail(`${name} artifact belongs to a different workflow run.`);
  }
  return { digest, id, name };
}

function resolveArtifacts() {
  validateTargetInputs();
  const receipt = artifactByName(
    authorityRunId,
    `mobile-release-ref-${platform}-${authorityRunId}-1`,
  );
  const values = {
    receipt_digest: receipt.digest,
    receipt_id: receipt.id,
    receipt_name: receipt.name,
  };
  if (operation === "record") {
    const intent = artifactByName(
      authorityRunId,
      `mobile-release-intent-${platform}-${authorityRunId}-1`,
    );
    Object.assign(values, {
      intent_digest: intent.digest,
      intent_id: intent.id,
      intent_name: intent.name,
    });
  }
  output(values);
}

function verifyArtifact(id, digest, name, expectedName, label) {
  positiveDecimal(id, `${label} artifact ID`);
  canonicalDigest(digest, `${label} artifact digest`);
  if (name !== expectedName) {
    fail(`${label} artifact name does not match authority run.`);
  }
  const artifact = JSON.parse(gh(["api", `repos/${repository}/actions/artifacts/${id}`]));
  if (
    String(artifact.id ?? "") !== id ||
    artifact.name !== name ||
    artifact.expired !== false ||
    artifact.digest !== digest ||
    String(artifact.workflow_run?.id ?? "") !== authorityRunId
  ) {
    fail(`${label} artifact metadata does not match its immutable tuple.`);
  }
}

function verifyAttestation(file, sourceDigest) {
  gh([
    "attestation",
    "verify",
    file,
    "--repo",
    repository,
    "--signer-workflow",
    `${repository}/${workflowPath}`,
    "--source-ref",
    "refs/heads/main",
    "--source-digest",
    sourceDigest,
    "--deny-self-hosted-runners",
  ]);
}

function readReceipt() {
  verifyArtifact(
    receiptArtifactId,
    receiptArtifactDigest,
    receiptArtifactName,
    `mobile-release-ref-${platform}-${authorityRunId}-1`,
    "Authority receipt",
  );
  const file = strictArtifactFile(receiptDirectory(), "receipt.json", MAX_RECEIPT_BYTES);
  const source = fs.readFileSync(file);
  const receipt = JSON.parse(source.toString("utf8"));
  exactReceiptKeys(receipt);
  if (!source.equals(canonicalBytes(receipt))) {
    fail("Mobile release authority receipt is not canonical JSON.");
  }
  const receiptDigest = sha256(source);
  verifyAttestation(file, receipt.workflowSha);
  return { receipt, receiptDigest };
}

function validateReceiptTuple(receipt) {
  if (
    receipt.kind !== "openclaw-mobile-release-authority" ||
    receipt.schemaVersion !== 2 ||
    receipt.platform !== platform ||
    receipt.repository !== repository ||
    receipt.runAttempt !== 1 ||
    String(receipt.runId) !== authorityRunId ||
    receipt.targetRef !== targetRef ||
    receipt.targetSha !== targetSha ||
    receipt.workflowPath !== workflowPath ||
    receipt.workflowFullRef !== `${repository}/${workflowPath}@refs/heads/main`
  ) {
    fail("Mobile release authority receipt does not match the requested release tuple.");
  }
  fullSha(receipt.workflowSha, "receipt workflow SHA");
  canonicalReleaseRef(receipt.targetRef);
  fullSha(receipt.targetSha, "receipt target SHA");
}

function validateOriginalRun(receipt, expectedStatus, expectedConclusion) {
  const timestamp = validateDispatchLifecycle(
    {
      actor: receipt.actor,
      runId: authorityRunId,
      triggeringActor: receipt.triggeringActor,
      workflowSha: receipt.workflowSha,
    },
    expectedStatus,
    expectedConclusion,
  );
  if (timestamp !== receipt.buildTimestamp) {
    fail("Mobile release authority timestamp no longer matches its original run.");
  }
}

function validateCandidateAgainstReceipt(candidate, receipt) {
  const expected = {
    androidPhoneVersionCode: receipt.androidPhoneVersionCode,
    androidVersionName: receipt.androidVersionName,
    androidWearVersionCode: receipt.androidWearVersionCode,
    gatewayVersion: receipt.gatewayVersion,
    iosAppStoreVersion: receipt.iosAppStoreVersion,
  };
  if (
    Object.keys(candidate).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => candidate[key] !== value)
  ) {
    fail("Trusted cutter output no longer matches the authority receipt.");
  }
}

function validateTargetCheckout() {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace || git(workspace, "rev-parse", "HEAD") !== targetSha) {
    fail("Mobile beta release checkout does not match target-sha.");
  }
  if (git(workspace, "diff", "--name-only") || git(workspace, "diff", "--cached", "--name-only")) {
    fail("Mobile beta release checkout has tracked changes after target validation.");
  }
}

async function authorize() {
  validateTargetInputs();
  if (recovery) {
    fail("Initial authorization cannot run in recovery mode.");
  }
  const current = validateCurrentDispatchEnvironment();
  const timestamp = validateCurrentDispatchLifecycle(current);
  if (
    authorityRunId !== current.runId ||
    actor !== current.actor ||
    triggeringActor !== current.actor
  ) {
    fail("Initial mobile release authority inputs do not match the workflow dispatch.");
  }
  collaboratorPermission(actor);
  const candidate = await validateStableReleaseCandidate(workflowSha, true);
  collaboratorPermission(actor);
  const receipt = {
    actor,
    ...candidate,
    buildTimestamp: timestamp,
    kind: "openclaw-mobile-release-authority",
    platform,
    repository,
    runAttempt: 1,
    runId: authorityRunId,
    schemaVersion: 2,
    targetRef,
    targetSha,
    triggeringActor,
    workflowFullRef,
    workflowPath,
    workflowSha,
  };
  validateOriginalRun(receipt, "in_progress", null);
  const bytes = canonicalBytes(receipt);
  const destination = receiptPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  output({
    actor,
    approved: "true",
    artifact_name: `mobile-release-ref-${platform}-${authorityRunId}-1`,
    build_timestamp: timestamp,
    gateway_version: candidate.gatewayVersion,
    receipt_digest: sha256(bytes),
    run_id: authorityRunId,
    target_ref: targetRef,
    target_sha: targetSha,
    triggering_actor: triggeringActor,
  });
}

async function revalidateUpload() {
  validateTargetInputs();
  if (recovery) {
    fail("Store upload revalidation cannot run in recovery mode.");
  }
  const current = validateCurrentDispatchEnvironment();
  validateCurrentDispatchLifecycle(current);
  if (authorityRunId !== current.runId) {
    fail("Store upload must remain in its original authority run.");
  }
  const { receipt, receiptDigest } = readReceipt();
  validateReceiptTuple(receipt);
  validateOriginalRun(receipt, "in_progress", null);
  collaboratorPermission(receipt.actor);
  const candidate = await validateStableReleaseCandidate(receipt.workflowSha, false);
  validateCandidateAgainstReceipt(candidate, receipt);
  validateTargetCheckout();
  collaboratorPermission(receipt.actor);
  validateOriginalRun(receipt, "in_progress", null);
  output({
    gateway_version: receipt.gatewayVersion,
    receipt_digest: receiptDigest,
  });
}

function readIntent() {
  verifyArtifact(
    intentArtifactId,
    intentArtifactDigest,
    intentArtifactName,
    `mobile-release-intent-${platform}-${authorityRunId}-1`,
    "Release intent",
  );
  strictArtifactFile(intentDirectory(), "intent.json", 4 * 1024);
  return readMobileReleaseIntent(intentPath());
}

function validateIntentTuple(intent, receipt, receiptDigest) {
  if (
    intent.authorityReceiptDigest !== receiptDigest ||
    intent.gatewayVersion !== receipt.gatewayVersion ||
    intent.platform !== platform ||
    intent.targetRef !== targetRef ||
    intent.targetSha !== targetSha
  ) {
    fail("Mobile release intent does not match its approved authority tuple.");
  }
  if (platform === "ios" && intent.appStoreVersion !== receipt.iosAppStoreVersion) {
    fail("iOS release intent does not match the cutter-selected App Store version.");
  }
  if (
    platform === "android" &&
    (intent.phoneTrack !== "internal" ||
      intent.wearTrack !== "wear:internal" ||
      intent.releaseStatus !== "completed" ||
      intent.playEditState !== "committed" ||
      intent.versionName !== receipt.androidVersionName ||
      intent.phoneVersionCode !== receipt.androidPhoneVersionCode ||
      intent.wearVersionCode !== receipt.androidWearVersionCode)
  ) {
    fail("Android release intent does not match the approved Play destination and store result.");
  }
}

function validateRecordRunLifecycle(current, receipt) {
  if (recovery) {
    validateOriginalRun(receipt, "completed", "failure");
    validateCurrentDispatchLifecycle(current);
    return;
  }
  validateOriginalRun(receipt, "in_progress", null);
}

async function validateRecordAuthority() {
  validateTargetInputs();
  const current = validateCurrentDispatchEnvironment();
  validateCurrentDispatchLifecycle(current);
  const verifyRecoveryRefs = recovery ? stableReleaseRefs(workflowSha, targetSha, true) : null;
  const { receipt, receiptDigest } = readReceipt();
  validateReceiptTuple(receipt);
  const intent = readIntent();
  validateIntentTuple(intent, receipt, receiptDigest);

  if (recovery) {
    if (current.runId === authorityRunId || current.actor !== receipt.actor) {
      fail("Record-only recovery must be a new dispatch by the original release actor.");
    }
  } else if (current.runId !== authorityRunId || current.actor !== receipt.actor) {
    fail("Release recording must remain in the original protected workflow run.");
  }
  validateRecordRunLifecycle(current, receipt);
  collaboratorPermission(receipt.actor);
  const candidate = await validateStableReleaseCandidate(receipt.workflowSha, false);
  validateCandidateAgainstReceipt(candidate, receipt);
  verifyRecoveryRefs?.();
  collaboratorPermission(receipt.actor);
  validateRecordRunLifecycle(current, receipt);
  return { current, intent, receipt };
}

function readReleaseRef(ref) {
  const endpoint = `repos/${repository}/git/ref/${ref.replace(/^refs\//u, "")}`;
  const result = ghWithReleaseToken(["api", endpoint, "--jq", ".object.sha"], true);
  return result === null ? null : fullSha(result, `existing ${ref}`);
}

function createReleaseRef(ref) {
  ghWithReleaseToken([
    "api",
    `repos/${repository}/git/refs`,
    "--method",
    "POST",
    "-f",
    `ref=${ref}`,
    "-f",
    `sha=${targetSha}`,
  ]);
}

async function recordReleaseRef() {
  if (!releaseRefToken) {
    fail("MOBILE_RELEASE_REF_TOKEN is required only for the trusted record phase.");
  }
  const { current, intent, receipt } = await validateRecordAuthority();
  const ref = mobileReleaseRefForIntent(intent);
  const existing = readReleaseRef(ref);
  if (existing && existing !== targetSha) {
    fail(`Mobile release ref ${ref} already points at a different commit.`);
  }
  if (!existing) {
    if (readRef(`refs/heads/${targetRef}`) !== targetSha) {
      fail("Mobile release branch changed immediately before immutable ref creation.");
    }
    collaboratorPermission(receipt.actor);
    validateRecordRunLifecycle(current, receipt);
    try {
      createReleaseRef(ref);
    } catch {
      const raced = readReleaseRef(ref);
      if (raced !== targetSha) {
        throw new Error(`Failed to create immutable mobile release ref ${ref}.`);
      }
    }
  }
  if (readReleaseRef(ref) !== targetSha) {
    fail(`Mobile release ref ${ref} failed final verification.`);
  }
  output({ release_ref: ref, release_sha: targetSha });
}

validateTrustedWorkflow();
switch (process.argv[2]) {
  case "resolve-artifacts":
    resolveArtifacts();
    break;
  case "authorize":
    if (operation !== "authorize") {
      fail("authorize phase requires authorize operation.");
    }
    await authorize();
    break;
  case "revalidate":
    if (operation !== "revalidate") {
      fail("revalidate phase requires revalidate operation.");
    }
    await revalidateUpload();
    break;
  case "validate-record":
    if (operation !== "record") {
      fail("validate-record phase requires record operation.");
    }
    await validateRecordAuthority();
    break;
  case "record":
    if (operation !== "record") {
      fail("record phase requires record operation.");
    }
    await recordReleaseRef();
    break;
  default:
    fail("Unknown mobile release authority phase.");
}

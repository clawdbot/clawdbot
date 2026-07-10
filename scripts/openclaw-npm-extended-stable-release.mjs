#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const SUPPORTED_DIST_TAGS = new Set(["alpha", "beta", "latest", "extended-stable"]);

export function parseExtendedStableGuardBypass(value = "") {
  if (value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`BYPASS_EXTENDED_STABLE_GUARD must be "true" or "false"; got "${value}".`);
}

function requireExtendedStableBypassTag(npmDistTag, bypassExtendedStableGuard) {
  if (bypassExtendedStableGuard && npmDistTag !== "extended-stable") {
    throw new Error(
      "BYPASS_EXTENDED_STABLE_GUARD may only be used with the extended-stable npm dist-tag.",
    );
  }
}

export function validateNpmPublishBoundary(
  packageVersion,
  npmDistTag,
  { bypassExtendedStableGuard = false } = {},
) {
  if (!SUPPORTED_DIST_TAGS.has(npmDistTag)) {
    throw new Error(`Unsupported npm dist-tag "${npmDistTag}".`);
  }
  requireExtendedStableBypassTag(npmDistTag, bypassExtendedStableGuard);
  const parsed = parseReleaseVersion(packageVersion);
  if (parsed === null) {
    throw new Error(`Unsupported release version "${packageVersion}".`);
  }

  if (parsed.channel === "alpha") {
    if (npmDistTag !== "alpha") {
      throw new Error("Alpha prereleases must publish to the alpha npm dist-tag.");
    }
    return parsed;
  }
  if (parsed.channel === "beta") {
    if (npmDistTag !== "beta") {
      throw new Error("Beta prereleases must publish to the beta npm dist-tag.");
    }
    return parsed;
  }

  if (npmDistTag === "extended-stable") {
    if (parsed.correctionNumber !== undefined) {
      throw new Error("Extended-stable npm publication does not allow correction suffixes.");
    }
    if (!bypassExtendedStableGuard && parsed.patch < 33) {
      throw new Error("Extended-stable npm publication requires release patch 33 or above.");
    }
    return parsed;
  }
  if (parsed.patch >= 33) {
    throw new Error(
      `Final or correction release patch 33 and above must publish to the extended-stable npm dist-tag; got ${npmDistTag}.`,
    );
  }
  return parsed;
}

export function validateExtendedStableNpmReleaseRequest(request) {
  const bypassExtendedStableGuard = request.bypassExtendedStableGuard ?? false;
  requireExtendedStableBypassTag(request.npmDistTag, bypassExtendedStableGuard);
  const shaPreflight =
    request.preflightOnly === true && /^[0-9a-f]{40}$/iu.test(request.releaseTag);
  if (shaPreflight) {
    if (!/^[0-9a-f]{40}$/iu.test(request.checkoutSha)) {
      throw new Error("Validation-only SHA preflight requires the full checked-out commit SHA.");
    }
    if (request.releaseTag.toLowerCase() !== request.checkoutSha.toLowerCase()) {
      throw new Error("Validation-only SHA must match the checked-out commit exactly.");
    }
  }
  const effectiveReleaseTag = shaPreflight ? `v${request.packageVersion}` : request.releaseTag;
  const taggedVersion = effectiveReleaseTag.startsWith("v")
    ? parseReleaseVersion(effectiveReleaseTag.slice(1))
    : null;

  if (request.npmDistTag !== "extended-stable") {
    if (taggedVersion !== null) {
      validateNpmPublishBoundary(taggedVersion.version, request.npmDistTag, {
        bypassExtendedStableGuard,
      });
    } else if (!SUPPORTED_DIST_TAGS.has(request.npmDistTag)) {
      throw new Error(`Unsupported npm dist-tag "${request.npmDistTag}".`);
    }
    return { extendedStable: false };
  }

  if (
    taggedVersion === null ||
    effectiveReleaseTag !== `v${taggedVersion.version}` ||
    taggedVersion.channel !== "stable"
  ) {
    throw new Error(
      "Extended-stable npm publication requires an exact final vYYYY.M.P release tag.",
    );
  }
  validateNpmPublishBoundary(taggedVersion.version, request.npmDistTag, {
    bypassExtendedStableGuard,
  });

  const releaseVersion = taggedVersion.version;
  const extendedStableBranch = `extended-stable/${taggedVersion.year}.${taggedVersion.month}.33`;
  if (request.packageVersion !== releaseVersion) {
    throw new Error(
      `Extended-stable npm package version mismatch: expected ${releaseVersion}, got ${request.packageVersion}.`,
    );
  }

  if (!shaPreflight) {
    const expectedWorkflowRef = `refs/heads/${extendedStableBranch}`;
    if (request.npmWorkflowRef !== expectedWorkflowRef) {
      throw new Error(
        `Extended-stable npm workflow ref mismatch: expected ${expectedWorkflowRef}, got ${request.npmWorkflowRef}.`,
      );
    }
    const shaValues = [request.checkoutSha, request.tagSha, request.extendedStableBranchSha];
    if (shaValues.some((sha) => !/^[0-9a-f]{40}$/iu.test(sha))) {
      throw new Error("Extended-stable npm release identity requires full 40-character Git SHAs.");
    }
    if (new Set(shaValues.map((sha) => sha.toLowerCase())).size !== 1) {
      throw new Error("Extended-stable npm checkout, tag, and branch tip SHAs must match exactly.");
    }
  }

  if (bypassExtendedStableGuard) {
    return {
      extendedStable: true,
      releaseVersion,
      extendedStableBranch,
      bypassExtendedStableGuard: true,
    };
  }

  const mainVersion = parseReleaseVersion(request.mainPackageVersion);
  if (
    mainVersion === null ||
    mainVersion.channel !== "stable" ||
    mainVersion.correctionNumber !== undefined
  ) {
    throw new Error("Protected main package version must be an exact final YYYY.M.P version.");
  }
  const mainCalendarMonth = mainVersion.year * 12 + mainVersion.month;
  const releaseCalendarMonth = taggedVersion.year * 12 + taggedVersion.month;
  if (mainCalendarMonth <= releaseCalendarMonth) {
    throw new Error(
      `Protected main must be in a later calendar month than ${taggedVersion.year}.${taggedVersion.month}; got ${request.mainPackageVersion}.`,
    );
  }
  if (mainVersion.patch >= 33) {
    throw new Error("Protected main must remain on a daily patch below 33.");
  }
  return { extendedStable: true, releaseVersion, extendedStableBranch };
}

export function validateExtendedStableRunIdentity({
  run,
  kind,
  npmDistTag,
  expectedBranch,
  expectedSha,
}) {
  const expectedWorkflowName =
    kind === "preflight"
      ? "OpenClaw NPM Release"
      : kind === "plugin"
        ? "Plugin NPM Release"
        : "Full Release Validation";
  const checks = [
    ["workflowName", expectedWorkflowName],
    ["event", "workflow_dispatch"],
    ...(kind === "validation" || kind === "plugin" ? [["status", "completed"]] : []),
    ["conclusion", "success"],
    ...(kind === "plugin" && npmDistTag === "extended-stable"
      ? [["displayTitle", `Plugin NPM Release [extended-stable] ${expectedSha}`]]
      : []),
  ];
  for (const [key, expected] of checks) {
    if (run[key] !== expected) {
      throw new Error(
        `Referenced ${kind} run must have ${key}=${expected}, got ${run[key] ?? "<missing>"}.`,
      );
    }
  }
  if (
    npmDistTag === "extended-stable" &&
    (run.headBranch !== expectedBranch || run.headSha !== expectedSha)
  ) {
    throw new Error(
      `Referenced extended-stable ${kind} run must have headBranch=${expectedBranch} and headSha=${expectedSha}; got ${run.headBranch ?? "<missing>"} and ${run.headSha ?? "<missing>"}.`,
    );
  }
  return run;
}

export function validateFullReleaseValidationManifest({
  manifest,
  npmDistTag,
  expectedWorkflowRef,
  expectedSha,
  expectedRunId,
  expectedRunAttempt,
}) {
  if (manifest.workflowName !== "Full Release Validation") {
    throw new Error(
      `Full release validation manifest workflow mismatch: ${manifest.workflowName ?? "<missing>"}.`,
    );
  }
  if (manifest.targetSha !== expectedSha) {
    throw new Error(
      `Full release validation target SHA mismatch: expected ${expectedSha}, got ${manifest.targetSha ?? "<missing>"}.`,
    );
  }
  if (expectedRunId !== undefined && String(manifest.runId) !== String(expectedRunId)) {
    throw new Error(
      `Full release validation run ID mismatch: expected ${expectedRunId}, got ${manifest.runId ?? "<missing>"}.`,
    );
  }
  if (
    expectedRunAttempt !== undefined &&
    String(manifest.runAttempt) !== String(expectedRunAttempt)
  ) {
    throw new Error(
      `Full release validation run attempt mismatch: expected ${expectedRunAttempt}, got ${manifest.runAttempt ?? "<missing>"}.`,
    );
  }
  if (npmDistTag === "extended-stable" && manifest.workflowRef !== expectedWorkflowRef) {
    throw new Error(
      `Full release validation workflow ref mismatch: expected ${expectedWorkflowRef}, got ${manifest.workflowRef ?? "<missing>"}.`,
    );
  }
  return manifest;
}

export function parsePriorExtendedStableSelector(stdout) {
  let tags;
  try {
    tags = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`npm dist-tags query returned invalid JSON: ${message}`, {
      cause: error,
    });
  }
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
    throw new Error("npm dist-tags query did not return a JSON object.");
  }
  if (!Object.hasOwn(tags, "extended-stable")) {
    return "absent";
  }
  if (typeof tags["extended-stable"] !== "string" || tags["extended-stable"].trim() === "") {
    throw new Error("npm extended-stable dist-tag was not a non-empty version string.");
  }
  return tags["extended-stable"];
}

export function capturePriorExtendedStableSelector({ query }) {
  const result = query();
  if (result.status !== 0) {
    throw new Error(`npm dist-tags query failed with exit code ${result.status ?? "unknown"}.`);
  }
  return parsePriorExtendedStableSelector(result.stdout);
}

export async function verifyExtendedStableRegistryReadback({
  expectedVersion,
  query,
  sleep,
  attempts = 12,
  delayMs = 10_000,
}) {
  let exactVersion = "missing";
  let extendedStableSelector = "missing";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const exactResult = await query(`openclaw@${expectedVersion}`);
    const extendedStableResult = await query("openclaw@extended-stable");
    exactVersion = exactResult.status === 0 ? exactResult.stdout.trim() : "missing";
    extendedStableSelector =
      extendedStableResult.status === 0 ? extendedStableResult.stdout.trim() : "missing";
    if (exactVersion === expectedVersion && extendedStableSelector === expectedVersion) {
      return { exactVersion, extendedStableSelector, attemptsUsed: attempt };
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  throw new Error(
    `npm registry did not converge to openclaw@${expectedVersion} and openclaw@extended-stable=${expectedVersion} after ${attempts} attempts (exact=${exactVersion}, extended-stable=${extendedStableSelector}).`,
  );
}

export function extendedStableSelectorRepairCommand(expectedVersion) {
  const normalizedVersion = (expectedVersion ?? "").replace(/^v/u, "");
  const parsed = parseReleaseVersion(normalizedVersion);
  if (parsed === null || parsed.channel !== "stable" || parsed.correctionNumber !== undefined) {
    throw new Error("Extended-stable selector repair requires an exact final YYYY.M.P version.");
  }
  return `npm dist-tag add openclaw@${parsed.version} extended-stable`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function packageVersionAt(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`])).version;
}

function validateRequestFromRepository() {
  const npmDistTag = process.env.RELEASE_NPM_DIST_TAG ?? "";
  const releaseTag = process.env.RELEASE_TAG ?? "";
  const npmWorkflowRef = process.env.NPM_WORKFLOW_REF ?? "";
  const preflightOnly = process.env.PREFLIGHT_ONLY === "true";
  const bypassExtendedStableGuard = parseExtendedStableGuardBypass(
    process.env.BYPASS_EXTENDED_STABLE_GUARD ?? "",
  );
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (npmDistTag !== "extended-stable") {
    return validateExtendedStableNpmReleaseRequest({
      bypassExtendedStableGuard,
      npmDistTag,
      releaseTag,
      npmWorkflowRef,
      checkoutSha: "",
      tagSha: "",
      extendedStableBranchSha: "",
      packageVersion,
      mainPackageVersion: "",
    });
  }

  const shaPreflight = preflightOnly && /^[0-9a-f]{40}$/iu.test(releaseTag);
  const effectiveReleaseTag = shaPreflight ? `v${packageVersion}` : releaseTag;
  const parsed = effectiveReleaseTag.startsWith("v")
    ? parseReleaseVersion(effectiveReleaseTag.slice(1))
    : null;
  if (!parsed || parsed.channel !== "stable" || parsed.correctionNumber !== undefined) {
    return validateExtendedStableNpmReleaseRequest({
      npmDistTag,
      bypassExtendedStableGuard,
      releaseTag,
      preflightOnly,
      npmWorkflowRef,
      checkoutSha: "",
      tagSha: "",
      extendedStableBranchSha: "",
      packageVersion,
      mainPackageVersion: "",
    });
  }
  const extendedStableBranch = `extended-stable/${parsed.year}.${parsed.month}.33`;
  if (shaPreflight) {
    if (!bypassExtendedStableGuard) {
      execFileSync(
        "git",
        ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        { stdio: "inherit" },
      );
    }
    const checkoutSha = git(["rev-parse", "HEAD"]);
    return validateExtendedStableNpmReleaseRequest({
      npmDistTag,
      bypassExtendedStableGuard,
      releaseTag,
      preflightOnly,
      npmWorkflowRef,
      checkoutSha,
      tagSha: checkoutSha,
      extendedStableBranchSha: "",
      packageVersion,
      mainPackageVersion: bypassExtendedStableGuard
        ? ""
        : packageVersionAt("refs/remotes/origin/main"),
    });
  }
  if (bypassExtendedStableGuard) {
    execFileSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${extendedStableBranch}:refs/remotes/origin/${extendedStableBranch}`,
      ],
      { stdio: "inherit" },
    );
    execFileSync(
      "git",
      ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
      { stdio: "inherit" },
    );
    return validateExtendedStableNpmReleaseRequest({
      npmDistTag,
      bypassExtendedStableGuard,
      releaseTag,
      npmWorkflowRef,
      checkoutSha: git(["rev-parse", "HEAD"]),
      tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
      extendedStableBranchSha: git(["rev-parse", `refs/remotes/origin/${extendedStableBranch}`]),
      packageVersion,
      mainPackageVersion: "",
    });
  }
  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${extendedStableBranch}:refs/remotes/origin/${extendedStableBranch}`,
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "git",
    ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
    { stdio: "inherit" },
  );
  return validateExtendedStableNpmReleaseRequest({
    npmDistTag,
    bypassExtendedStableGuard,
    releaseTag,
    npmWorkflowRef,
    checkoutSha: git(["rev-parse", "HEAD"]),
    tagSha: git(["rev-parse", `${releaseTag}^{commit}`]),
    extendedStableBranchSha: git(["rev-parse", `refs/remotes/origin/${extendedStableBranch}`]),
    packageVersion,
    mainPackageVersion: packageVersionAt("refs/remotes/origin/main"),
  });
}

function appendOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    throw new Error("GITHUB_OUTPUT is required.");
  }
  appendFileSync(
    output,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "validate-request") {
    const result = validateRequestFromRepository();
    console.log(
      result.extendedStable
        ? `Validated extended-stable npm release ${result.releaseVersion}.`
        : "Validated regular npm release request.",
    );
    return;
  }
  if (command === "publish-plan") {
    const npmDistTag = process.env.REQUESTED_PUBLISH_TAG ?? "";
    const bypassExtendedStableGuard = parseExtendedStableGuardBypass(
      process.env.BYPASS_EXTENDED_STABLE_GUARD ?? "",
    );
    const parsed = validateNpmPublishBoundary(process.env.PACKAGE_VERSION ?? "", npmDistTag, {
      bypassExtendedStableGuard,
    });
    console.log(parsed.channel);
    console.log(npmDistTag);
    return;
  }
  if (command === "verify-run") {
    const run = JSON.parse(readFileSync(0, "utf8"));
    validateExtendedStableRunIdentity({
      run,
      kind: process.env.RUN_KIND,
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      expectedBranch: process.env.EXPECTED_EXTENDED_STABLE_BRANCH,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
    });
    console.log(`Verified referenced ${process.env.RUN_KIND} run.`);
    return;
  }
  if (command === "verify-manifest") {
    const manifest = JSON.parse(readFileSync(process.env.MANIFEST_FILE, "utf8"));
    validateFullReleaseValidationManifest({
      manifest,
      npmDistTag: process.env.RELEASE_NPM_DIST_TAG,
      expectedWorkflowRef: process.env.EXPECTED_WORKFLOW_REF,
      expectedSha: process.env.EXPECTED_RELEASE_SHA,
      expectedRunId: process.env.FULL_RELEASE_VALIDATION_RUN_ID,
      expectedRunAttempt: process.env.FULL_RELEASE_VALIDATION_RUN_ATTEMPT,
    });
    return;
  }
  if (command === "capture-selector") {
    const previous = capturePriorExtendedStableSelector({
      query: () =>
        spawnSync("npm", ["view", "openclaw", "dist-tags", "--json"], { encoding: "utf8" }),
    });
    appendOutput({ previous });
    return;
  }
  if (command === "verify-readback") {
    const expectedVersion = (process.env.EXPECTED_VERSION ?? "").replace(/^v/u, "");
    const result = await verifyExtendedStableRegistryReadback({
      expectedVersion,
      query: (target) => spawnSync("npm", ["view", target, "version"], { encoding: "utf8" }),
      sleep: (delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    });
    appendOutput({
      exact_version: result.exactVersion,
      extended_stable_selector: result.extendedStableSelector,
    });
    return;
  }
  if (command === "repair-command") {
    console.log(extendedStableSelectorRepairCommand(process.env.EXPECTED_VERSION));
    return;
  }
  throw new Error(`Unknown extended-stable npm release command: ${command ?? "<missing>"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openclaw-npm-extended-stable-release: ${message}`);
    process.exit(1);
  }
}

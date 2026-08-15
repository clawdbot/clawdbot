#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { detectChangedScope } from "../../../../scripts/ci-changed-scope.mjs";
import { isDirectRunUrl } from "../../../../scripts/lib/direct-run.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../../scripts/lib/local-build-metadata.mts";
import { runManagedCommand } from "../../../../scripts/lib/managed-child-process.mts";
import {
  runNodeConfigFiles,
  runNodeSourceRoots,
} from "../../../../scripts/run-node-watch-paths.mts";
import {
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
} from "../../../../scripts/run-node.mts";

const DEFAULT_EXPECTED_ORIGIN = "openclaw/openclaw";
const FULL_SHA_RE = /^[0-9a-f]{40}$/u;
const GATEWAY_READINESS_ATTEMPTS = 7;
const GATEWAY_READINESS_RETRY_DELAY_MS = 5_000;
const GATEWAY_CLI_TIMEOUT_MS = 30_000;
const DEFAULT_LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;
const MAX_LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 300;
const LAUNCHD_TEARDOWN_MARGIN_MS = 15_000;
const GATEWAY_STOP_PROOF_RETRY_DELAY_MS = 250;
const GATEWAY_PROCESS_START_TIMEOUT_MS = 20_000;
const GATEWAY_PROCESS_START_RETRY_DELAY_MS = 250;
const GATEWAY_SUSPEND_TIMEOUT_MS = 10_000;
const LEAF_COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = Object.freeze({
  dependencyInstall: 15 * 60_000,
  gatewayBuild: 20 * 60_000,
  gatewayProbe: GATEWAY_CLI_TIMEOUT_MS,
  gatewayService: 60_000,
  gitFetch: 5 * 60_000,
  gitMerge: 2 * 60_000,
  macAppRebuild: 30 * 60_000,
});
const GATEWAY_STARTUP_TRACE_ENV = "OPENCLAW_GATEWAY_STARTUP_TRACE";
const SYSTEM_LAUNCH_DAEMON_DIR = "/Library/LaunchDaemons";
const MAX_FAILURE_DIAGNOSTIC_DEPTH = 4;
const MAX_FAILURE_DIAGNOSTIC_MEMBERS = 8;
const SAFE_INVARIANT_DETAIL_KEYS = [
  "elapsedMs",
  "exitTimeoutSeconds",
  "listenerClosed",
  "lockRetained",
  "manualRecoveryRequired",
  "phase",
  "processExited",
  "processTreeState",
  "serviceBootedOut",
  "serviceState",
  "timeoutMs",
];
// CLI diagnostics stay typed and bounded because child-process errors can
// retain argv, environment, and output that must never enter the JSON result.
const aggregateDiagnosticMembers = new WeakMap();
const GENERATED_LAUNCH_AGENT_ENV_WRAPPER = `#!/bin/sh
set -eu
env_file="$1"
shift
if [ -f "$env_file" ]; then
  . "$env_file"
fi
exec "$@"
`;
const DEPENDENCY_INPUT_RE =
  /^(?:\.npmrc$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|patches\/)|(?:^|\/)package\.json$/u;

/**
 * @typedef {object} GatewayDeploymentRef
 * @property {string} entrypoint
 */

/**
 * The fields required when the updater invokes the managed Gateway CLI.
 * LaunchAgent inspection returns a richer object, while focused probes may
 * provide only this execution view.
 *
 * @typedef {object} GatewayCliDeploymentBase
 * @property {string} configPath
 * @property {string} entrypoint
 * @property {string} executable
 * @property {string[]} invocationPrefix
 * @property {number} port
 * @property {Record<string, string>} [serviceEnvironment]
 * @property {string | null} [workingDirectory]
 */

/**
 * @typedef {GatewayCliDeploymentBase & {
 *   envFilePath?: null,
 *   runtime?: string,
 *   wrapperPath?: null,
 * }} DirectGatewayCliDeployment
 */

/**
 * @typedef {GatewayCliDeploymentBase & {
 *   envFilePath: string,
 *   runtime: string,
 *   wrapperPath: string,
 * }} WrappedGatewayCliDeployment
 */

/** @typedef {DirectGatewayCliDeployment | WrappedGatewayCliDeployment} GatewayCliDeployment */

/**
 * The stable identity fields used to verify a LaunchAgent retarget.
 * Repointing deliberately does not require the execution-only fields above.
 *
 * @typedef {object} GatewayRepointDeployment
 * @property {string} configPath
 * @property {string} entrypoint
 * @property {string} label
 * @property {number} port
 */

/**
 * The updater's established test/API result keeps owner details extensible,
 * while naming the fields every completed maintenance run exposes.
 *
 * @typedef {Record<string, unknown> & {
 *   actions: Record<string, unknown>,
 *   buildBefore: Record<string, unknown>,
 *   changedPaths?: string[],
 *   macTarget?: Record<string, unknown>,
 *   release?: () => void,
 * }} UpdateResult
 */

class UpdateInvariantError extends Error {
  constructor(code, message, details, options) {
    super(message, options);
    this.name = "UpdateInvariantError";
    this.code = code;
    this.details = details;
  }
}

class UpdateCommandError extends Error {
  constructor(operation, error) {
    super(retainedErrorMessage(error), { cause: error });
    this.name = "UpdateCommandError";
    this.operation = operation;
    const status = ownDataProperty(error, "status");
    const signal = ownDataProperty(error, "signal");
    if (Number.isInteger(status)) {
      this.status = status;
    }
    if (typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal)) {
      this.signal = signal;
    }
  }
}

/**
 * Re-throw the original runtime value while exposing the Error contract to type-aware lint.
 *
 * @returns {never}
 */
function throwPreservingValue(value) {
  throw /** @type {Error} */ (value);
}

function ownDataProperty(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function failureMessage(error) {
  if (error instanceof Error) {
    if (error instanceof UpdateCommandError) {
      return `${error.operation} failed`;
    }
    const status = ownDataProperty(error, "status");
    const signal = ownDataProperty(error, "signal");
    if (
      Number.isInteger(status) ||
      (typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal))
    ) {
      return "external command failed";
    }
    const message = ownDataProperty(error, "message");
    return typeof message === "string" ? message : error.name;
  }
  try {
    return String(error);
  } catch {
    return "unknown updater failure";
  }
}

function retainedErrorMessage(error) {
  if (error instanceof Error) {
    const message = ownDataProperty(error, "message");
    return typeof message === "string" ? message : error.name;
  }
  try {
    return String(error);
  } catch {
    return "unknown updater failure";
  }
}

function aggregateErrorWithCause(members, message, cause) {
  const error = new AggregateError(
    members.map((member) => member.error),
    message,
    { cause },
  );
  aggregateDiagnosticMembers.set(error, members);
  return error;
}

function gatewayCliOperation(args) {
  if (args[0] === "gateway" && args[1] === "call") {
    if (args[2] === "gateway.suspend.prepare") {
      return "gateway.suspend.prepare";
    }
    if (args[2] === "gateway.suspend.resume") {
      return "gateway.suspend.resume";
    }
    return "gateway.call";
  }
  if (args[0] === "gateway" && args[1] === "status") {
    return "gateway.status";
  }
  if (args[0] === "health") {
    return "gateway.health";
  }
  return "gateway.cli";
}

function isLegacyGatewaySuspendPrepareParamsError(error) {
  if (
    !(error instanceof UpdateCommandError) ||
    error.operation !== "gateway.suspend.prepare" ||
    error.status !== 1
  ) {
    return false;
  }
  const cause = ownDataProperty(error, "cause");
  const stdout = ownDataProperty(cause, "stdout");
  if (typeof stdout !== "string" || !stdout.trim()) {
    return false;
  }
  let payload;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    payload.ok !== false
  ) {
    return false;
  }
  const requestError = payload.error;
  return (
    typeof requestError === "object" &&
    requestError !== null &&
    !Array.isArray(requestError) &&
    Object.keys(requestError).length === 4 &&
    requestError.type === "gateway_request_error" &&
    requestError.code === "INVALID_REQUEST" &&
    requestError.message === "invalid gateway.suspend.prepare params" &&
    requestError.retryable === false
  );
}

async function runUpdateCommand(runCommand, operation, command, args, checkout, options) {
  try {
    return await runCommand(command, args, checkout, options);
  } catch (error) {
    if (
      error instanceof UpdateInvariantError ||
      error instanceof UpdateCommandError ||
      error instanceof AggregateError
    ) {
      throw error;
    }
    throw new UpdateCommandError(operation, error);
  }
}

function formatInvariantDetails(details) {
  const formatted = {};
  for (const key of SAFE_INVARIANT_DETAIL_KEYS) {
    const value = ownDataProperty(details, key);
    if (typeof value === "boolean") {
      formatted[key] = value;
    } else if (
      ["elapsedMs", "exitTimeoutSeconds", "timeoutMs"].includes(key) &&
      Number.isInteger(value)
    ) {
      formatted[key] = value;
    } else if (key === "phase" && typeof value === "string") {
      formatted[key] = value;
    } else if (
      key === "processTreeState" &&
      ["indeterminate", "live", "terminated"].includes(value)
    ) {
      formatted[key] = value;
    } else if (key === "serviceState" && ["running", "stopped", "stopping"].includes(value)) {
      formatted[key] = value;
    }
  }
  return Object.keys(formatted).length > 0 ? formatted : undefined;
}

function formatCommandDiagnostic(error, operation) {
  const diagnostic = { kind: "command", operation };
  const status = ownDataProperty(error, "status");
  const signal = ownDataProperty(error, "signal");
  if (Number.isInteger(status)) {
    diagnostic.status = status;
  }
  if (typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal)) {
    diagnostic.signal = signal;
  }
  return diagnostic;
}

function formatFailureDiagnostic(error, state, depth = 0) {
  if (depth >= MAX_FAILURE_DIAGNOSTIC_DEPTH) {
    return { kind: "truncated", reason: "depth_limit" };
  }
  if ((typeof error === "object" || typeof error === "function") && error !== null) {
    if (state.seen.has(error)) {
      return { kind: "truncated", reason: "cycle" };
    }
    state.seen.add(error);
  }
  if (error instanceof UpdateInvariantError) {
    const details = formatInvariantDetails(error.details);
    const cause = ownDataProperty(error, "cause");
    return {
      kind: "invariant",
      code: error.code,
      ...(details ? { details } : {}),
      ...(cause === undefined ? {} : { cause: formatFailureDiagnostic(cause, state, depth + 1) }),
    };
  }
  if (error instanceof UpdateCommandError) {
    return formatCommandDiagnostic(error, error.operation);
  }
  if (error instanceof AggregateError) {
    const rawErrors = ownDataProperty(error, "errors");
    const errors = Array.isArray(rawErrors) ? rawErrors : [];
    const members =
      aggregateDiagnosticMembers.get(error) ??
      errors.map((memberError, index) => ({
        role: index === 0 ? "primary" : "secondary",
        error: memberError,
      }));
    const limitedMembers = members.slice(0, MAX_FAILURE_DIAGNOSTIC_MEMBERS);
    const diagnostic = {
      kind: "aggregate",
      members: limitedMembers.map((member) => ({
        role: member.role,
        error: formatFailureDiagnostic(member.error, state, depth + 1),
      })),
    };
    const cause = ownDataProperty(error, "cause");
    const causeMember = members.findIndex((member) => member.error === cause);
    if (causeMember >= 0 && causeMember < limitedMembers.length) {
      diagnostic.causeMember = causeMember;
    }
    if (members.length > limitedMembers.length) {
      diagnostic.omittedMembers = members.length - limitedMembers.length;
    }
    return diagnostic;
  }
  const status = ownDataProperty(error, "status");
  const signal = ownDataProperty(error, "signal");
  if (Number.isInteger(status) || (typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal))) {
    return formatCommandDiagnostic(error, "external_command");
  }
  return { kind: error instanceof Error ? "error" : "thrown_value" };
}

export function formatUpdateFailure(error) {
  const code = error instanceof UpdateInvariantError ? error.code : "update_failed";
  const message = failureMessage(error);
  return {
    schemaVersion: 1,
    ok: false,
    error: {
      code,
      message,
      diagnostics: formatFailureDiagnostic(error, { seen: new Set() }),
    },
  };
}

function findUpdateInvariantError(value, code) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || (typeof current !== "object" && typeof current !== "function")) {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof UpdateInvariantError && current.code === code) {
      return current;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
    if ("cause" in current) {
      pending.push(current.cause);
    }
  }
  return null;
}

function findUnsafeCommandCleanupFailure(value) {
  const failure = findUpdateInvariantError(value, "command_cleanup_failed");
  const unsafeTreeState = ["indeterminate", "live"].includes(failure?.details?.processTreeState);
  const retainedByProcessGroup = Number.isSafeInteger(failure?.details?.processGroupId);
  const retainedForManualRecovery = failure?.details?.manualRecoveryRequired === true;
  return failure && unsafeTreeState && (retainedByProcessGroup || retainedForManualRecovery)
    ? failure
    : null;
}

function boundedSyncOptions(options = {}, timeoutMs = LEAF_COMMAND_TIMEOUT_MS) {
  return {
    ...options,
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  };
}

function git(checkout, args, options = {}) {
  return execFileSync("git", ["-C", checkout, ...args], {
    ...boundedSyncOptions({}, options.timeoutMs),
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function gitText(checkout, args) {
  return git(checkout, args).trim();
}

function configValue(checkout, key, bool = false) {
  try {
    return gitText(checkout, ["config", ...(bool ? ["--bool"] : ["--get"]), key]);
  } catch {
    return "";
  }
}

function githubSlug(remoteUrl) {
  const match = remoteUrl.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/iu,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function applicableUrlRewrite(checkout, remoteUrl) {
  let output;
  try {
    output = gitText(checkout, ["config", "--get-regexp", "^url\\..*\\.insteadOf$"]);
  } catch {
    return null;
  }
  return (
    output
      .split("\n")
      .map((line) => line.match(/^\S+\s+(.+)$/u)?.[1]?.trim())
      .filter(Boolean)
      .filter((prefix) => remoteUrl.startsWith(prefix))
      .toSorted((left, right) => right.length - left.length)[0] ?? null
  );
}

export function originMatches(remoteUrl) {
  return githubSlug(remoteUrl) === DEFAULT_EXPECTED_ORIGIN;
}

function changedPathsBetween(checkout, beforeSha, afterSha) {
  return git(checkout, ["diff", "--name-only", "-z", beforeSha, afterSha], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function commitExists(checkout, sha) {
  try {
    git(checkout, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestorCommit(checkout, ancestor, descendant = "HEAD") {
  try {
    git(checkout, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function classifyActions(
  changedPaths,
  { buildProvenanceKnown, buildRequired, nodeModulesPresent },
) {
  // CI skips generated protocol-only macOS jobs, but the live app embeds these Swift sources.
  const generatedMacProtocolChanged = changedPaths.some((changedPath) =>
    changedPath.startsWith("apps/shared/OpenClawKit/Sources/OpenClawProtocol/"),
  );
  const runMacos =
    changedPaths.length > 0 &&
    (detectChangedScope(changedPaths).runMacos || generatedMacProtocolChanged);
  const macUiVerification =
    runMacos &&
    changedPaths.some((changedPath) =>
      /^(?:apps\/macos\/Sources\/|apps\/shared\/OpenClawKit\/Sources\/|apps\/swabble\/Sources\/)/u.test(
        changedPath,
      ),
    );
  const dependencyInputsChanged = changedPaths.some((changedPath) =>
    DEPENDENCY_INPUT_RE.test(changedPath),
  );
  const dependencyInstall =
    !nodeModulesPresent || (buildRequired && (dependencyInputsChanged || !buildProvenanceKnown));
  return {
    dependencyInstall,
    gatewayBuild: buildRequired,
    gatewayProbe: true,
    gatewayRestart: buildRequired || dependencyInstall,
    gatewaySelfHeal: false,
    macAppRebuild: runMacos,
    macUiVerification,
  };
}

function readStampHead(checkout, stampFile) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(checkout, "dist", stampFile), "utf8"));
    return typeof parsed.head === "string" && FULL_SHA_RE.test(parsed.head.toLowerCase())
      ? parsed.head.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function canonicalBuildRequirements(checkout) {
  const distRoot = path.join(checkout, "dist");
  const fsImpl = { existsSync, readFileSync, readdirSync, statSync };
  const deps = {
    cwd: checkout,
    env: process.env,
    fs: fsImpl,
    spawnSync: (command, args, options) => spawnSync(command, args, boundedSyncOptions(options)),
    distRoot,
    distEntry: path.join(distRoot, "entry.js"),
    buildStampPath: path.join(distRoot, BUILD_STAMP_FILE),
    runtimePostBuildStampPath: path.join(distRoot, RUNTIME_POSTBUILD_STAMP_FILE),
    sourceRoots: runNodeSourceRoots.map((sourceRoot) => ({
      name: sourceRoot,
      path: path.join(checkout, sourceRoot),
    })),
    configFiles: runNodeConfigFiles.map((filePath) => path.join(checkout, filePath)),
  };
  return {
    build: resolveBuildRequirement(deps),
    runtimePostBuild: resolveRuntimePostBuildRequirement(deps),
  };
}

function missingControlUiAssets(checkout) {
  const root = path.join(checkout, "dist/control-ui");
  const indexPath = path.join(root, "index.html");
  let html;
  try {
    html = readFileSync(indexPath, "utf8");
  } catch {
    return ["index.html"];
  }
  const references = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/giu)]
    .map((match) => match[1].split(/[?#]/u, 1)[0])
    .filter(
      (reference) => reference && reference !== "/" && !/^(?:[a-z]+:|\/\/|#)/iu.test(reference),
    )
    .map((reference) => reference.replace(/^\.\//u, ""));
  const missing = references.filter((reference) => {
    const candidate = path.resolve(root, reference.replace(/^\//u, ""));
    return (
      !candidate.startsWith(`${root}${path.sep}`) ||
      !statSync(candidate, { throwIfNoEntry: false })?.isFile()
    );
  });
  const assetsDir = path.join(root, "assets");
  let hasAssetPayload = false;
  try {
    hasAssetPayload = readdirSync(assetsDir, { withFileTypes: true }).some((entry) =>
      entry.isFile(),
    );
  } catch {
    // Report the missing payload below.
  }
  if (!hasAssetPayload) {
    missing.push("assets/*");
  }
  return [...new Set(missing)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function inspectBuildState(checkout, expectedSha) {
  const buildInfoPath = path.join(checkout, "dist/build-info.json");
  const uiPath = path.join(checkout, "dist/control-ui/index.html");
  let commit = null;
  try {
    const parsed = JSON.parse(readFileSync(buildInfoPath, "utf8"));
    commit = typeof parsed.commit === "string" ? parsed.commit.toLowerCase() : null;
    if (!commit || !FULL_SHA_RE.test(commit)) {
      commit = null;
    }
  } catch {
    // Missing or invalid provenance is handled below.
  }
  const buildStampHead = readStampHead(checkout, BUILD_STAMP_FILE);
  const runtimePostBuildStampHead = readStampHead(checkout, RUNTIME_POSTBUILD_STAMP_FILE);
  const requirements = canonicalBuildRequirements(checkout);
  const missingUiAssets = missingControlUiAssets(checkout);
  const requiredFilesPresent =
    existsSync(buildInfoPath) && existsSync(uiPath) && missingUiAssets.length === 0;
  const current =
    requiredFilesPresent &&
    commit === expectedSha &&
    buildStampHead === expectedSha &&
    runtimePostBuildStampHead === expectedSha &&
    !requirements.build.shouldBuild &&
    !requirements.runtimePostBuild.shouldSync;
  const missingCanonicalOutput =
    !requiredFilesPresent ||
    requirements.build.reason.startsWith("missing_") ||
    requirements.runtimePostBuild.reason.startsWith("missing_");
  return {
    current,
    state: current ? "current" : missingCanonicalOutput ? "missing" : commit ? "stale" : "invalid",
    commit,
    buildStampHead,
    runtimePostBuildStampHead,
    missingUiAssets,
    requirements,
  };
}

function verifyCheckout(checkout, { remote }) {
  let resolvedCheckout;
  try {
    resolvedCheckout = realpathSync(checkout);
  } catch {
    throw new UpdateInvariantError("checkout_missing", `checkout does not exist: ${checkout}`);
  }

  const gitDir = path.join(resolvedCheckout, ".git");
  const gitDirStat = lstatSync(gitDir, { throwIfNoEntry: false });
  if (!gitDirStat?.isDirectory() || gitDirStat.isSymbolicLink()) {
    throw new UpdateInvariantError(
      "not_standalone_clone",
      `checkout must contain its own .git directory: ${resolvedCheckout}`,
    );
  }
  if (
    realpathSync(gitText(resolvedCheckout, ["rev-parse", "--show-toplevel"])) !== resolvedCheckout
  ) {
    throw new UpdateInvariantError(
      "checkout_not_root",
      "checkout path must be the repository root",
    );
  }

  const commonDir = realpathSync(
    path.resolve(resolvedCheckout, gitText(resolvedCheckout, ["rev-parse", "--git-common-dir"])),
  );
  if (commonDir !== realpathSync(gitDir)) {
    throw new UpdateInvariantError("linked_worktree", "checkout uses a shared Git directory");
  }
  if (gitText(resolvedCheckout, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new UpdateInvariantError("shallow_clone", "checkout must be a full clone");
  }
  if (configValue(resolvedCheckout, "core.sparseCheckout", true) === "true") {
    throw new UpdateInvariantError("sparse_checkout", "checkout must not use sparse checkout");
  }
  if (
    configValue(resolvedCheckout, `remote.${remote}.promisor`, true) === "true" ||
    configValue(resolvedCheckout, "extensions.partialClone")
  ) {
    throw new UpdateInvariantError("partial_clone", "checkout must not use partial clone filters");
  }
  if (existsSync(path.join(gitDir, "objects/info/alternates"))) {
    throw new UpdateInvariantError("borrowed_objects", "checkout must own its Git objects");
  }

  const worktreeCount = gitText(resolvedCheckout, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
  if (worktreeCount !== 1) {
    throw new UpdateInvariantError(
      "multiple_worktrees",
      `checkout must own exactly one worktree; found ${worktreeCount}`,
    );
  }

  const branch = gitText(resolvedCheckout, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") {
    throw new UpdateInvariantError("wrong_branch", `checkout must be on main; found ${branch}`);
  }
  if (gitText(resolvedCheckout, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new UpdateInvariantError("dirty_checkout", "checkout has tracked or untracked changes");
  }

  const remoteUrl = configValue(resolvedCheckout, `remote.${remote}.url`);
  if (!originMatches(remoteUrl)) {
    throw new UpdateInvariantError(
      "unexpected_origin",
      `${remote} points to ${remoteUrl}; expected ${DEFAULT_EXPECTED_ORIGIN}`,
    );
  }
  const rewrite = applicableUrlRewrite(resolvedCheckout, remoteUrl);
  if (rewrite) {
    throw new UpdateInvariantError(
      "rewritten_origin",
      `${remote} URL is affected by a Git insteadOf rewrite for ${rewrite}`,
    );
  }
  return {
    checkout: resolvedCheckout,
    branch,
    headSha: gitText(resolvedCheckout, ["rev-parse", "HEAD"]),
    remoteUrl,
  };
}

async function updateMain({ checkout, remote }, runCommand, dependencies = {}) {
  const before = verifyCheckout(checkout, { remote });
  const fetchMain =
    dependencies.fetchMain ??
    ((target, remoteName) =>
      runUpdateCommand(
        runCommand,
        "git.fetch",
        "git",
        [
          "-C",
          target,
          "fetch",
          "--prune",
          remoteName,
          `refs/heads/main:refs/remotes/${remoteName}/main`,
        ],
        target,
        {
          phase: "Git fetch",
          serviceState: "running",
          timeoutMs: COMMAND_TIMEOUT_MS.gitFetch,
        },
      ));
  await fetchMain(before.checkout, remote);
  const afterFetch = verifyCheckout(before.checkout, { remote });
  if (afterFetch.headSha !== before.headSha) {
    throw new UpdateInvariantError(
      "concurrent_head_change",
      `HEAD changed during fetch: ${before.headSha} -> ${afterFetch.headSha}`,
    );
  }

  const remoteSha = gitText(before.checkout, ["rev-parse", `${remote}/main`]);
  await runUpdateCommand(
    runCommand,
    "git.merge",
    "git",
    ["-C", before.checkout, "merge", "--ff-only", `${remote}/main`],
    before.checkout,
    {
      phase: "Git fast-forward merge",
      serviceState: "running",
      timeoutMs: COMMAND_TIMEOUT_MS.gitMerge,
    },
  );
  const after = verifyCheckout(before.checkout, { remote });
  if (after.headSha !== remoteSha) {
    throw new UpdateInvariantError(
      "local_main_diverged",
      `local main ${after.headSha} does not equal ${remote}/main ${remoteSha}`,
    );
  }
  const updated = before.headSha !== after.headSha;
  return {
    checkout: before.checkout,
    remote,
    branch: after.branch,
    beforeSha: before.headSha,
    afterSha: after.headSha,
    remoteSha,
    updated,
    changedPaths: updated
      ? changedPathsBetween(before.checkout, before.headSha, after.headSha)
      : [],
  };
}

function defaultLockPath(checkout) {
  const key = createHash("sha256").update(path.resolve(checkout)).digest("hex").slice(0, 12);
  return path.join(tmpdir(), `openclaw-live-updater-${key}.lock`);
}

function defaultStatePath(checkout) {
  return path.join(realpathSync(checkout), ".git", "openclaw-live-updater-state.json");
}

function readMaintenanceState(statePath) {
  if (!existsSync(statePath)) {
    return {};
  }
  try {
    const stat = lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("unsafe state file");
    }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch {
    throw new UpdateInvariantError(
      "invalid_state",
      `maintenance state is unreadable: ${statePath}`,
    );
  }
}

function writeMaintenanceState(statePath, state) {
  const directory = path.dirname(statePath);
  const temporary = path.join(directory, `.openclaw-live-updater-${process.pid}-${randomUUID()}`);
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, statePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupAlive(processGroupId) {
  if (
    process.platform === "win32" ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 1
  ) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function acquireMaintenanceLock(checkout, requestedPath) {
  const lockPath = requestedPath ?? defaultLockPath(checkout);
  let incompleteLockRetries = 0;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let stat;
      try {
        stat = lstatSync(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UpdateInvariantError("unsafe_lock", `refusing unsafe lock path: ${lockPath}`);
      }
      let owner;
      try {
        owner = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      } catch {
        // The mkdir winner publishes owner.json right after creating the lock
        // dir, so readers can see ENOENT before the write and an empty/partial
        // file during writeFileSync's open-truncate window. Both are
        // creation-in-progress, not corruption; re-read within the bounded
        // budget and only then declare the lock invalid.
        if (incompleteLockRetries < 20) {
          incompleteLockRetries += 1;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          continue;
        }
        throw new UpdateInvariantError("invalid_lock", `lock owner is unreadable: ${lockPath}`);
      }
      incompleteLockRetries = 0;
      const ownerProcessAlive = Number.isInteger(owner.pid) && processAlive(owner.pid);
      const blockedProcessGroupAlive =
        Number.isInteger(owner.processGroupId) && processGroupAlive(owner.processGroupId);
      const manualRecoveryRequired = owner.manualRecoveryRequired === true;
      if (ownerProcessAlive || blockedProcessGroupAlive || manualRecoveryRequired) {
        return { acquired: false, lockPath, owner };
      }
      const staleClaim = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(lockPath, staleClaim);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") {
          continue;
        }
        throw renameError;
      }
      rmSync(staleClaim, { recursive: true });
    }
  }

  const owner = {
    pid: process.pid,
    checkout: path.resolve(checkout),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx" });
  return {
    acquired: true,
    lockPath,
    owner,
    retainForCleanupFailure(details = {}) {
      const processGroupId = details.processGroupId;
      const manualRecoveryRequired = details.manualRecoveryRequired === true;
      if (
        (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) &&
        !manualRecoveryRequired
      ) {
        throw new UpdateInvariantError(
          "invalid_cleanup_lock",
          "refusing to retain maintenance lock without a process group or manual recovery state",
        );
      }
      const ownerPath = path.join(lockPath, "owner.json");
      const current = JSON.parse(readFileSync(ownerPath, "utf8"));
      if (current.pid !== process.pid) {
        throw new UpdateInvariantError("lock_owner_changed", "maintenance lock ownership changed");
      }
      const retainedOwner = {
        ...current,
        blockedAt: new Date().toISOString(),
        reason: "command_cleanup_failed",
        ...(Number.isSafeInteger(processGroupId) ? { processGroupId } : {}),
        ...(manualRecoveryRequired ? { manualRecoveryRequired: true } : {}),
        ...(typeof details.phase === "string" ? { phase: details.phase } : {}),
        ...(typeof details.processTreeState === "string"
          ? { processTreeState: details.processTreeState }
          : {}),
        ...(typeof details.serviceState === "string" ? { serviceState: details.serviceState } : {}),
      };
      writeFileSync(ownerPath, `${JSON.stringify(retainedOwner)}\n`, { mode: 0o600 });
      return retainedOwner;
    },
    release() {
      const current = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      if (current.pid !== process.pid) {
        throw new UpdateInvariantError("lock_owner_changed", "maintenance lock ownership changed");
      }
      rmSync(lockPath, { recursive: true });
    },
  };
}

async function defaultRunCommand(command, args, checkout, options = {}) {
  const phase = options.phase ?? "command";
  const timeoutMs = options.timeoutMs ?? LEAF_COMMAND_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    const managedRunner = options.runManagedCommand ?? runManagedCommand;
    const status = await managedRunner({
      bin: command,
      args,
      cwd: checkout,
      requireProcessTreeExit: true,
      stdio: ["ignore", 2, 2],
      timeoutMs,
    });
    if (status !== 0) {
      throw new Error(`${phase} command exited with status ${status}`);
    }
  } catch (error) {
    if (error?.code === "EPROCESS_TREE_VERIFICATION_UNSUPPORTED") {
      throw new UpdateInvariantError(
        "unsupported_process_tree_verification",
        `${phase} requires process-tree verification unavailable on this platform`,
        {
          phase,
          serviceState: options.serviceState ?? "running",
        },
      );
    }
    if (error?.code === "EPROCESSGROUP_CLEANUP_FAILED") {
      throw new UpdateInvariantError(
        "command_cleanup_failed",
        `${phase} process tree could not be cleaned up`,
        {
          elapsedMs: Date.now() - startedAt,
          phase,
          ...(Number.isSafeInteger(error.processGroupId)
            ? { processGroupId: error.processGroupId }
            : {}),
          ...(typeof error.processTreeState === "string"
            ? { processTreeState: error.processTreeState }
            : {}),
          ...(error.manualRecoveryRequired === true ? { manualRecoveryRequired: true } : {}),
          serviceState: options.serviceState ?? "running",
          timeoutMs,
        },
      );
    }
    if (error?.code !== "ETIMEDOUT") {
      throw error;
    }
    throw new UpdateInvariantError("command_timeout", `${phase} timed out after ${timeoutMs}ms`, {
      elapsedMs: Date.now() - startedAt,
      phase,
      serviceState: options.serviceState ?? "running",
      timeoutMs,
    });
  }
}

function readSnapshotMetadata(snapshotRoot) {
  const gitDir = path.join(snapshotRoot, ".git");
  const headPath = path.join(gitDir, "HEAD");
  const configPath = path.join(gitDir, "config");
  const gitDirStat = lstatSync(gitDir);
  const headStat = lstatSync(headPath);
  const configStat = lstatSync(configPath);
  const owner = typeof process.getuid === "function" ? process.getuid() : null;
  const isTrustedMetadataFile = (filePath, fileStat) =>
    fileStat.isFile() &&
    !fileStat.isSymbolicLink() &&
    (owner === null || fileStat.uid === owner) &&
    (fileStat.mode & 0o022) === 0 &&
    realpathSync(filePath) === filePath;
  if (
    !gitDirStat.isDirectory() ||
    gitDirStat.isSymbolicLink() ||
    realpathSync(gitDir) !== gitDir ||
    !isTrustedMetadataFile(headPath, headStat) ||
    !isTrustedMetadataFile(configPath, configStat)
  ) {
    return null;
  }

  const head = readFileSync(headPath, "utf8").trim().toLowerCase();
  if (!FULL_SHA_RE.test(head)) {
    return null;
  }
  let inOrigin = false;
  let originUrl = null;
  for (const rawLine of readFileSync(configPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inOrigin = /^\[remote\s+"origin"\]$/u.test(line);
      continue;
    }
    if (!inOrigin) {
      continue;
    }
    const urlMatch = line.match(/^url\s*=\s*(.+)$/u);
    if (urlMatch) {
      originUrl = urlMatch[1].trim().replace(/^"(.*)"$/u, "$1");
      break;
    }
  }
  return originUrl ? { head, originUrl } : null;
}

export function isOwnedGatewayEntrypoint(checkout, home, entrypoint) {
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (entrypoint === sourceEntrypoint) {
    return true;
  }

  const runtimeRoot = path.join(home, ".openclaw/runtime");
  const snapshotRoot = path.dirname(path.dirname(entrypoint));
  const snapshotName = path.basename(snapshotRoot);
  if (
    path.dirname(snapshotRoot) !== runtimeRoot ||
    !/^gateway-[0-9a-f]{7}$/u.test(snapshotName) ||
    path.basename(path.dirname(entrypoint)) !== "dist" ||
    path.basename(entrypoint) !== "index.js"
  ) {
    return false;
  }

  try {
    const metadata = readSnapshotMetadata(snapshotRoot);
    const entrypointStat = lstatSync(entrypoint);
    const owner = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      realpathSync(snapshotRoot) !== snapshotRoot ||
      realpathSync(entrypoint) !== entrypoint ||
      !entrypointStat.isFile() ||
      entrypointStat.isSymbolicLink() ||
      (owner !== null && entrypointStat.uid !== owner) ||
      (entrypointStat.mode & 0o022) !== 0 ||
      !metadata ||
      !originMatches(metadata.originUrl)
    ) {
      return false;
    }
    const snapshotHead = metadata.head;
    if (
      !FULL_SHA_RE.test(snapshotHead) ||
      snapshotName !== `gateway-${snapshotHead.slice(0, 7)}` ||
      !commitExists(checkout, snapshotHead) ||
      !isAncestorCommit(checkout, snapshotHead)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveManagedGatewayCommand(
  programArguments,
  home,
  stateDir,
  label = "ai.openclaw.gateway",
) {
  if (!Array.isArray(programArguments)) {
    return null;
  }
  const defaultEnvDir = path.join(stateDir ?? path.join(home, ".openclaw"), "service-env");
  let envDir = defaultEnvDir;
  let envFilePath = null;
  let commandStartIndex = 0;
  let executable = programArguments[0];
  let prefix = [];
  let wrapperPath = null;
  const acceptsGeneratedWrapper = (candidateWrapper, candidateEnvFile) => {
    const candidateDir = path.dirname(candidateWrapper);
    return (
      path.basename(candidateDir) === "service-env" &&
      path.dirname(candidateEnvFile) === candidateDir &&
      path.basename(candidateWrapper) === `${label}-env-wrapper.sh` &&
      path.basename(candidateEnvFile) === `${label}.env`
    );
  };
  if (
    programArguments[0] === "/bin/sh" &&
    typeof programArguments[1] === "string" &&
    typeof programArguments[2] === "string" &&
    acceptsGeneratedWrapper(programArguments[1], programArguments[2])
  ) {
    wrapperPath = programArguments[1];
    envFilePath = programArguments[2];
    envDir = path.dirname(wrapperPath);
    commandStartIndex = 3;
    prefix = [wrapperPath, envFilePath];
  } else if (
    typeof programArguments[0] === "string" &&
    typeof programArguments[1] === "string" &&
    acceptsGeneratedWrapper(programArguments[0], programArguments[1])
  ) {
    wrapperPath = programArguments[0];
    envFilePath = programArguments[1];
    envDir = path.dirname(wrapperPath);
    commandStartIndex = 2;
    executable = wrapperPath;
    prefix = [envFilePath];
  }
  const runtime = programArguments[commandStartIndex];
  const entrypoint = programArguments[commandStartIndex + 1];
  const command = programArguments[commandStartIndex + 2];
  // Arbitrary --wrapper executables contain no checkout entrypoint, so their
  // ownership cannot be proven and conversion must remain a manual operation.
  return typeof runtime === "string" &&
    ["bun", "node"].includes(path.basename(runtime)) &&
    typeof entrypoint === "string" &&
    command === "gateway"
    ? {
        entrypoint,
        entrypointIndex: commandStartIndex + 1,
        envFilePath,
        executable,
        invocationPrefix: wrapperPath ? [...prefix, runtime, entrypoint] : [entrypoint],
        runtime,
        stateDir: path.dirname(envDir),
        wrapperPath,
      }
    : null;
}

export function resolveManagedGatewayEntrypoint(programArguments, home, stateDir) {
  return resolveManagedGatewayCommand(programArguments, home, stateDir)?.entrypoint ?? null;
}

function isTrustedGeneratedEnvironmentWrapper(command) {
  if (!command.wrapperPath || !command.envFilePath) {
    return true;
  }
  try {
    const wrapperStat = lstatSync(command.wrapperPath);
    const envFileStat = lstatSync(command.envFilePath);
    const owner = process.getuid();
    return (
      wrapperStat.isFile() &&
      !wrapperStat.isSymbolicLink() &&
      envFileStat.isFile() &&
      !envFileStat.isSymbolicLink() &&
      wrapperStat.uid === owner &&
      envFileStat.uid === owner &&
      (wrapperStat.mode & 0o022) === 0 &&
      (envFileStat.mode & 0o077) === 0 &&
      realpathSync(command.wrapperPath) === command.wrapperPath &&
      realpathSync(command.envFilePath) === command.envFilePath &&
      readFileSync(command.wrapperPath, "utf8") === GENERATED_LAUNCH_AGENT_ENV_WRAPPER
    );
  } catch {
    return false;
  }
}

function isTrustedOwnedRegularFile(fileStat) {
  return (
    fileStat.isFile() &&
    !fileStat.isSymbolicLink() &&
    fileStat.uid === process.getuid() &&
    (fileStat.mode & 0o022) === 0
  );
}

export function resolveLaunchAgentExitTimeoutSeconds(value) {
  if (value === 0 || (Number.isInteger(value) && value > MAX_LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS)) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      `managed Gateway LaunchAgent ExitTimeOut=${value} prevents bounded stopped proof`,
      { exitTimeoutSeconds: value },
    );
  }
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS;
}

function isLaunchctlServiceMissing(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status !== 0 && /could not find service|no such process|not found/iu.test(output);
}

export function assertNoSystemLaunchDaemonOwnership(label, dependencies = {}) {
  const run = dependencies.spawnSync ?? spawnSync;
  const readDirectory = dependencies.readdirSync ?? readdirSync;
  const serviceTarget = `system/${label}`;
  const inspectLoadedService = () => {
    const result = run(
      "/bin/launchctl",
      ["print", serviceTarget],
      boundedSyncOptions({ encoding: "utf8" }),
    );
    if (result.status === 0) {
      throw new UpdateInvariantError(
        "gateway_system_launchdaemon_conflict",
        `System LaunchDaemon ${serviceTarget} already owns the managed Gateway label`,
      );
    }
    if (!isLaunchctlServiceMissing(result)) {
      throw new UpdateInvariantError(
        "gateway_system_launchdaemon_unverifiable",
        `could not verify system LaunchDaemon ownership for ${serviceTarget}`,
      );
    }
  };

  inspectLoadedService();
  let entries;
  try {
    entries = readDirectory(SYSTEM_LAUNCH_DAEMON_DIR);
  } catch (error) {
    if (error?.code === "ENOENT") {
      entries = [];
    } else {
      throw new UpdateInvariantError(
        "gateway_system_launchdaemon_unverifiable",
        `could not inspect ${SYSTEM_LAUNCH_DAEMON_DIR}: ${String(error)}`,
      );
    }
  }
  for (const entry of entries.filter((candidate) => candidate.endsWith(".plist")).toSorted()) {
    const plistPath = path.join(SYSTEM_LAUNCH_DAEMON_DIR, entry);
    const result = run(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", plistPath],
      boundedSyncOptions({ encoding: "utf8" }),
    );
    if (result.status !== 0) {
      throw new UpdateInvariantError(
        "gateway_system_launchdaemon_unverifiable",
        `could not inspect system LaunchDaemon plist ${plistPath}`,
      );
    }
    let plist;
    try {
      plist = JSON.parse(String(result.stdout));
    } catch {
      throw new UpdateInvariantError(
        "gateway_system_launchdaemon_unverifiable",
        `could not inspect system LaunchDaemon plist ${plistPath}`,
      );
    }
    if (plist?.Label === label) {
      throw new UpdateInvariantError(
        "gateway_system_launchdaemon_conflict",
        `System LaunchDaemon plist ${plistPath} already owns the managed Gateway label`,
      );
    }
  }
  // Close the query-to-directory-snapshot race at the activation boundary.
  inspectLoadedService();
}

function readManagedGatewayLaunchAgent(checkout) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    throw new UpdateInvariantError(
      "gateway_launchagent_unavailable",
      "managed Gateway LaunchAgent inspection is only available on macOS",
    );
  }
  const home = process.env.HOME;
  if (!home) {
    throw new UpdateInvariantError("gateway_launchagent_failed", "HOME is unavailable");
  }
  const plistPath = path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
  let plistStat;
  try {
    plistStat = lstatSync(plistPath);
  } catch (error) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      `could not inspect the managed Gateway LaunchAgent: ${String(error)}`,
    );
  }
  if (!isTrustedOwnedRegularFile(plistStat)) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      "managed Gateway LaunchAgent is not a regular owned plist file",
    );
  }
  const plistResult = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", plistPath],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  if (plistResult.status !== 0) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      `could not read the managed Gateway LaunchAgent: ${plistResult.stderr.trim()}`,
    );
  }
  const plist = JSON.parse(plistResult.stdout);
  const label = plist?.Label;
  const programArguments = plist?.ProgramArguments;
  const environmentVariables = plist?.EnvironmentVariables;
  const workingDirectory =
    typeof plist?.WorkingDirectory === "string" ? plist.WorkingDirectory : null;
  const exitTimeoutSeconds = resolveLaunchAgentExitTimeoutSeconds(plist?.ExitTimeOut);
  const serviceEnvironment = Object.fromEntries(
    Object.entries(environmentVariables ?? {}).filter((entry) => typeof entry[1] === "string"),
  );
  const stateDir =
    typeof environmentVariables?.OPENCLAW_STATE_DIR === "string"
      ? environmentVariables.OPENCLAW_STATE_DIR
      : path.join(home, ".openclaw");
  const gatewayCommand = resolveManagedGatewayCommand(programArguments, home, stateDir, label);
  const gatewayEntrypoint = gatewayCommand?.entrypoint ?? null;
  const ownsGatewayEntrypoint =
    gatewayEntrypoint !== null && isOwnedGatewayEntrypoint(checkout, home, gatewayEntrypoint);
  const portFlag = Array.isArray(programArguments) ? programArguments.indexOf("--port") : -1;
  const port = Number(portFlag >= 0 ? programArguments[portFlag + 1] : Number.NaN);
  if (
    typeof label !== "string" ||
    !Array.isArray(programArguments) ||
    !ownsGatewayEntrypoint ||
    !isTrustedGeneratedEnvironmentWrapper(gatewayCommand) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      "LaunchAgent does not describe this checkout's managed Gateway and port",
    );
  }
  const configPath =
    typeof plist?.EnvironmentVariables?.OPENCLAW_CONFIG_PATH === "string"
      ? plist.EnvironmentVariables.OPENCLAW_CONFIG_PATH
      : path.join(gatewayCommand.stateDir, "openclaw.json");
  return {
    configPath,
    entrypoint: gatewayEntrypoint,
    entrypointIndex: gatewayCommand.entrypointIndex,
    envFilePath: gatewayCommand.envFilePath,
    executable: gatewayCommand.executable,
    exitTimeoutSeconds,
    invocationPrefix: gatewayCommand.invocationPrefix,
    label,
    plistPath,
    port,
    runtime: gatewayCommand.runtime,
    serviceEnvironment,
    stateDir: gatewayCommand.stateDir,
    workingDirectory,
    wrapperPath: gatewayCommand.wrapperPath,
  };
}

function inspectManagedGatewayDeployment(checkout) {
  if (process.platform !== "darwin") {
    return null;
  }
  const home = process.env.HOME;
  if (!home || !existsSync(path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist"))) {
    return null;
  }
  return readManagedGatewayLaunchAgent(checkout);
}

/**
 * @param {string} checkout
 * @param {GatewayRepointDeployment} deployment
 * @param {(deployment: GatewayRepointDeployment, replacement: string) => void} replaceEntrypoint
 * @param {(checkout: string) => GatewayRepointDeployment | null} [inspectDeployment]
 * @returns {GatewayRepointDeployment & { changed: boolean, previousEntrypoint?: string }}
 */
export function repointManagedGatewayDeployment(
  checkout,
  deployment,
  replaceEntrypoint,
  inspectDeployment = inspectManagedGatewayDeployment,
) {
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (deployment.entrypoint === sourceEntrypoint) {
    return { changed: false, ...deployment };
  }
  replaceEntrypoint(deployment, sourceEntrypoint);
  const installed = inspectDeployment(checkout);
  if (
    !installed ||
    installed.configPath !== deployment.configPath ||
    installed.entrypoint !== sourceEntrypoint ||
    installed.label !== deployment.label ||
    installed.port !== deployment.port
  ) {
    throw new UpdateInvariantError(
      "gateway_repoint_failed",
      "managed Gateway LaunchAgent was not retargeted to the exact source build",
    );
  }
  return {
    changed: true,
    ...installed,
    previousEntrypoint: deployment.entrypoint,
  };
}

export function replaceLaunchAgentProgramArgument(programArguments, index, expected, replacement) {
  if (!Array.isArray(programArguments) || programArguments[index] !== expected) {
    throw new UpdateInvariantError(
      "gateway_repoint_failed",
      "managed Gateway LaunchAgent changed before its entrypoint could be replaced",
    );
  }
  return programArguments.with(index, replacement);
}

function prepareLaunchAgentEntrypointReplacement(deployment, entrypoint, options = {}) {
  const temporaryPath = `${deployment.plistPath}.openclaw-live-updater-${randomUUID()}`;
  const originalContents = readFileSync(deployment.plistPath);
  const originalDigest = createHash("sha256").update(originalContents).digest("hex");
  const originalMode = statSync(deployment.plistPath).mode;
  writeFileSync(temporaryPath, originalContents, {
    flag: "wx",
    mode: originalMode,
  });
  let installed = false;
  let replacementDigest = null;
  try {
    const plistResult = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", temporaryPath],
      boundedSyncOptions({ encoding: "utf8" }),
    );
    if (plistResult.status !== 0) {
      throw new UpdateInvariantError(
        "gateway_repoint_failed",
        `could not read the managed Gateway LaunchAgent: ${plistResult.stderr.trim()}`,
      );
    }
    const programArguments = replaceLaunchAgentProgramArgument(
      JSON.parse(plistResult.stdout)?.ProgramArguments,
      deployment.entrypointIndex,
      deployment.entrypoint,
      entrypoint,
    );
    execFileSync(
      "/usr/bin/plutil",
      ["-replace", "ProgramArguments", "-json", JSON.stringify(programArguments), temporaryPath],
      boundedSyncOptions({ stdio: ["ignore", "ignore", "pipe"] }),
    );
    execFileSync("/usr/bin/plutil", ["-lint", temporaryPath], {
      ...boundedSyncOptions({ stdio: ["ignore", "ignore", "pipe"] }),
    });
    const validatedResult = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", temporaryPath],
      boundedSyncOptions({ encoding: "utf8" }),
    );
    if (
      validatedResult.status !== 0 ||
      JSON.parse(validatedResult.stdout)?.ProgramArguments?.[deployment.entrypointIndex] !==
        entrypoint
    ) {
      throw new UpdateInvariantError(
        "gateway_repoint_failed",
        "replacement LaunchAgent did not preserve the validated entrypoint",
      );
    }
    replacementDigest = createHash("sha256").update(readFileSync(temporaryPath)).digest("hex");
    const restore = () => {
      if (!installed) {
        return false;
      }
      const currentDigest = createHash("sha256")
        .update(readFileSync(deployment.plistPath))
        .digest("hex");
      if (currentDigest !== replacementDigest) {
        throw new UpdateInvariantError(
          "gateway_repoint_restore_failed",
          "managed Gateway LaunchAgent changed after replacement installation",
        );
      }
      const rollbackPath = `${deployment.plistPath}.openclaw-live-updater-rollback-${randomUUID()}`;
      try {
        writeFileSync(rollbackPath, originalContents, {
          flag: "wx",
          mode: originalMode,
        });
        renameSync(rollbackPath, deployment.plistPath);
        installed = false;
        return true;
      } finally {
        rmSync(rollbackPath, { force: true });
      }
    };
    return {
      install() {
        const assertOwnership =
          options.assertNoSystemLaunchDaemonOwnership ?? assertNoSystemLaunchDaemonOwnership;
        assertOwnership(deployment.label);
        const currentDigest = createHash("sha256")
          .update(readFileSync(deployment.plistPath))
          .digest("hex");
        if (currentDigest !== originalDigest) {
          throw new UpdateInvariantError(
            "gateway_repoint_failed",
            "managed Gateway LaunchAgent changed after its replacement was prepared",
          );
        }
        renameSync(temporaryPath, deployment.plistPath);
        installed = true;
        try {
          assertOwnership(deployment.label);
        } catch (ownershipError) {
          try {
            restore();
          } catch (restoreError) {
            throw aggregateErrorWithCause(
              [
                { role: "primary", error: ownershipError },
                { role: "rollback", error: restoreError },
              ],
              "System LaunchDaemon ownership changed during plist publication and the previous LaunchAgent could not be restored",
              restoreError,
            );
          }
          throw ownershipError;
        }
      },
      restore,
      discard() {
        if (!installed) {
          rmSync(temporaryPath, { force: true });
        }
      },
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function replaceLaunchAgentEntrypoint(deployment, entrypoint) {
  const replacement = prepareLaunchAgentEntrypointReplacement(deployment, entrypoint);
  try {
    replacement.install();
  } finally {
    replacement.discard();
  }
}

function verifyManagedGatewayRuntime(checkout, expectedSha) {
  if (process.platform !== "darwin") {
    return null;
  }
  assertExactBuild(checkout, expectedSha);
  const deployment = inspectManagedGatewayDeployment(checkout);
  if (!deployment) {
    return null;
  }
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (deployment.entrypoint !== sourceEntrypoint) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "managed Gateway still targets an immutable ancestor snapshot after maintenance",
    );
  }
  const launchctl = spawnSync(
    "/bin/launchctl",
    ["print", `gui/${process.getuid()}/${deployment.label}`],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  const pidMatch = launchctl.status === 0 ? launchctl.stdout.match(/\bpid = (\d+)\b/u) : null;
  const pid = Number(pidMatch?.[1] ?? Number.NaN);
  const loadedArguments = parseLaunchctlArguments(launchctl.stdout);
  const loadedCommand = resolveManagedGatewayCommand(
    loadedArguments,
    process.env.HOME,
    deployment.stateDir,
    deployment.label,
  );
  const loadedPortFlag = loadedArguments.indexOf("--port");
  const loadedPort = Number(loadedPortFlag >= 0 ? loadedArguments[loadedPortFlag + 1] : Number.NaN);
  if (
    !loadedCommand ||
    loadedCommand.entrypoint !== sourceEntrypoint ||
    loadedCommand.executable !== deployment.executable ||
    loadedCommand.runtime !== deployment.runtime ||
    loadedCommand.wrapperPath !== deployment.wrapperPath ||
    loadedPort !== deployment.port
  ) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "loaded Gateway LaunchAgent arguments do not use the exact source entrypoint",
    );
  }
  if (!Number.isInteger(pid) || pid < 1) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "managed Gateway LaunchAgent has no running process after maintenance",
    );
  }
  const listeners = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${deployment.port}`, "-sTCP:LISTEN", "-t"],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  const listenerPids = listeners.stdout.trim().split(/\s+/u).filter(Boolean).map(Number);
  // The Gateway overwrites process.title, so ps cannot prove argv. The owned
  // LaunchAgent arguments plus its exact listener PID remain stable evidence.
  if (listeners.status !== 0 || !listenerPids.includes(pid)) {
    throw new UpdateInvariantError(
      "gateway_runtime_mismatch",
      "managed Gateway LaunchAgent PID does not own its configured listener",
    );
  }
  return { commit: expectedSha, entrypoint: sourceEntrypoint, pid, port: deployment.port };
}

export function parseLaunchctlArguments(output) {
  const block = output.match(/\n\s*arguments = \{\n(?<body>[\s\S]*?)\n\s*\}/u)?.groups?.body;
  return block
    ? block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

/**
 * @param {string} checkout
 * @param {string[]} args
 * @param {GatewayCliDeployment | null | undefined} deployment
 * @param {{ stderr?: "inherit" | "pipe", timeoutMs?: number }} [options]
 * @returns {string}
 */
export function runBuiltGatewayCli(checkout, args, deployment, options = {}) {
  const observedDeployment = deployment ?? readManagedGatewayLaunchAgent(checkout);
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  let managedDeployment = observedDeployment;
  if (observedDeployment.entrypoint !== sourceEntrypoint) {
    const currentHead = gitText(checkout, ["rev-parse", "HEAD"]);
    managedDeployment = resolveGatewayControlDeployment(
      checkout,
      observedDeployment,
      inspectBuildState(checkout, currentHead),
      currentHead,
    );
    if (!managedDeployment) {
      throw new UpdateInvariantError(
        "gateway_snapshot_control_unavailable",
        "refusing to execute a managed Gateway runtime snapshot without a trusted source control build",
      );
    }
  }
  const {
    configPath,
    entrypoint,
    envFilePath,
    executable,
    invocationPrefix,
    port,
    runtime,
    serviceEnvironment = {},
    workingDirectory,
    wrapperPath,
  } = managedDeployment;
  const baseEnv = { ...process.env };
  delete baseEnv.OPENCLAW_GATEWAY_URL;
  delete baseEnv.OPENCLAW_GATEWAY_TOKEN;
  delete baseEnv.OPENCLAW_GATEWAY_PASSWORD;
  delete baseEnv.OPENCLAW_CONFIG_PATH;
  delete baseEnv.OPENCLAW_GATEWAY_PORT;
  Object.assign(baseEnv, serviceEnvironment);
  delete baseEnv.OPENCLAW_GATEWAY_URL;
  let effectiveConfigPath = configPath;
  if (wrapperPath && envFilePath) {
    delete baseEnv.OPENCLAW_CONFIG_PATH;
    delete baseEnv.OPENCLAW_GATEWAY_PORT;
    const wrapperPrefix = executable === "/bin/sh" ? [wrapperPath, envFilePath] : [envFilePath];
    try {
      const configuredPath = execFileSync(
        executable,
        [...wrapperPrefix, "/usr/bin/printenv", "OPENCLAW_CONFIG_PATH"],
        boundedSyncOptions({
          encoding: "utf8",
          env: baseEnv,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).trim();
      if (configuredPath) {
        effectiveConfigPath = configuredPath;
      }
    } catch {
      // The service environment may rely on the state-directory default.
    }
  }
  const overlayPath = path.join(
    path.dirname(effectiveConfigPath),
    `.openclaw-live-updater-config-${randomUUID()}.json`,
  );
  writeFileSync(
    overlayPath,
    `${JSON.stringify({
      $include: `./${path.basename(effectiveConfigPath)}`,
      gateway: { mode: "local", port },
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const envOverrides = [`OPENCLAW_CONFIG_PATH=${overlayPath}`, `OPENCLAW_GATEWAY_PORT=${port}`];
  const env = Object.assign(baseEnv, {
    OPENCLAW_CONFIG_PATH: overlayPath,
    OPENCLAW_GATEWAY_PORT: String(port),
  });
  try {
    const callArgs =
      wrapperPath && envFilePath
        ? [
            ...(executable === "/bin/sh" ? [wrapperPath, envFilePath] : [envFilePath]),
            "/usr/bin/env",
            "-u",
            "OPENCLAW_GATEWAY_URL",
            ...envOverrides,
            runtime,
            entrypoint,
            ...args,
          ]
        : [...invocationPrefix, ...args];
    return execFileSync(executable, callArgs, {
      cwd: workingDirectory ?? path.dirname(path.dirname(entrypoint)),
      encoding: "utf8",
      env,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", options.stderr ?? "inherit"],
      timeout: options.timeoutMs ?? GATEWAY_CLI_TIMEOUT_MS,
    });
  } catch (error) {
    throw new UpdateCommandError(gatewayCliOperation(args), error);
  } finally {
    rmSync(overlayPath, { force: true });
  }
}

/**
 * @param {string} checkout
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {GatewayCliDeployment | null | undefined} deployment
 * @returns {string}
 */
export function runBuiltGatewayCall(checkout, method, params, deployment) {
  const managedDeployment = deployment ?? readManagedGatewayLaunchAgent(checkout);
  return runBuiltGatewayCli(
    checkout,
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      String(GATEWAY_SUSPEND_TIMEOUT_MS),
    ],
    managedDeployment,
  );
}

/**
 * @param {string} checkout
 * @param {(checkout: string, method: string, params: { requestId: string, terminalPolicy?: "terminate" }, deployment: GatewayCliDeployment | null) => string} [callGateway]
 * @param {GatewayCliDeployment | null} [deployment]
 */
export function prepareGatewaySuspension(
  checkout,
  callGateway = runBuiltGatewayCall,
  deployment = null,
) {
  const requestId = `openclaw-live-updater-${randomUUID()}`;
  const callPrepare = (params) =>
    JSON.parse(callGateway(checkout, "gateway.suspend.prepare", params, deployment));
  let result;
  try {
    try {
      result = callPrepare({ requestId, terminalPolicy: "terminate" });
    } catch (error) {
      if (!isLegacyGatewaySuspendPrepareParamsError(error)) {
        throw error;
      }
      // Older closed schemas reject the new field before acquiring a lease.
      // Retry once with preserve semantics so mixed-version updates remain safe.
      result = callPrepare({ requestId });
    }
  } catch (error) {
    throw new UpdateInvariantError(
      "gateway_suspend_prepare_failed",
      "could not atomically prepare Gateway maintenance",
      undefined,
      { cause: error },
    );
  }
  if (result?.status === "ready" && typeof result.suspensionId === "string") {
    return result;
  }
  if (result?.status === "busy" && Array.isArray(result.blockers)) {
    return result;
  }
  throw new UpdateInvariantError(
    "gateway_suspend_prepare_invalid",
    `Gateway returned an invalid suspension result: ${JSON.stringify(result)}`,
  );
}

function defaultResumeGatewaySuspension(checkout, suspensionId, deployment) {
  runBuiltGatewayCall(checkout, "gateway.suspend.resume", { suspensionId }, deployment);
}

async function stopManagedGateway(runCommand, checkout, deployment) {
  if (!deployment) {
    await runUpdateCommand(
      runCommand,
      "gateway.stop",
      process.execPath,
      ["dist/index.js", "gateway", "stop"],
      checkout,
      {
        phase: "gateway stop",
        serviceState: "stopping",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
      },
    );
    return;
  }
  await runUpdateCommand(
    runCommand,
    "launchd.bootout",
    "/bin/launchctl",
    ["bootout", `gui/${process.getuid()}/${deployment.label}`],
    checkout,
    {
      phase: "Gateway LaunchAgent bootout",
      serviceState: "stopping",
      timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
    },
  );
}

function timestampAt(readTimeMs) {
  const timeMs = readTimeMs();
  return new Date(timeMs).toISOString();
}

function recordStoppedMilestones(timing, observation, now) {
  const details = observation?.details ?? observation;
  if (details?.processExited === true) {
    recordGatewayTimestamp(timing, "processExitedAt", timestampAt(now));
  }
  if (details?.listenerClosed === true) {
    recordGatewayTimestamp(timing, "listenerClosedAt", timestampAt(now));
  }
}

async function stopManagedGatewayAndProve(
  runCommand,
  checkout,
  deployment,
  proveGatewayStopped,
  sleep,
  now = Date.now,
) {
  const timing = {
    bootoutStartedAt: timestampAt(now),
    bootoutCompletedAt: null,
    processExitedAt: null,
    listenerClosedAt: null,
    timestampSemantics: { bootoutStartedAt: "observed" },
  };
  let stopError;
  try {
    await stopManagedGateway(runCommand, checkout, deployment);
  } catch (error) {
    stopError = error;
  } finally {
    recordGatewayTimestamp(timing, "bootoutCompletedAt", timestampAt(now));
  }
  const exitTimeoutSeconds =
    Number.isInteger(deployment?.exitTimeoutSeconds) && deployment.exitTimeoutSeconds > 0
      ? deployment.exitTimeoutSeconds
      : DEFAULT_LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS;
  // launchd may retain the job until ExitTimeOut elapses. Match the native
  // restart owner by allowing that ceiling plus a bounded teardown margin.
  const proofTimeoutMs = exitTimeoutSeconds * 1_000 + LAUNCHD_TEARDOWN_MARGIN_MS;
  const proofAttempts = Math.ceil(proofTimeoutMs / GATEWAY_STOP_PROOF_RETRY_DELAY_MS) + 1;
  let proofError;
  for (let attempt = 0; attempt < proofAttempts; attempt += 1) {
    try {
      const proof = await proveGatewayStopped(checkout);
      recordStoppedMilestones(timing, proof, now);
      recordGatewayTimestamp(timing, "processExitedAt", timestampAt(now));
      recordGatewayTimestamp(timing, "listenerClosedAt", timestampAt(now));
      return { proof, timing };
    } catch (error) {
      proofError = error;
      recordStoppedMilestones(timing, error, now);
      if (attempt + 1 < proofAttempts) {
        await sleep(GATEWAY_STOP_PROOF_RETRY_DELAY_MS);
      }
    }
  }
  if (!stopError) {
    throw proofError;
  }
  throw aggregateErrorWithCause(
    [
      { role: "primary", error: stopError },
      { role: "proof", error: proofError },
    ],
    "Gateway stop command failed and native stopped proof did not converge",
    proofError,
  );
}

function isTrustedSourceControlBuild(checkout, buildState, currentHead) {
  if (buildState.current) {
    return true;
  }
  const commit = buildState.commit;
  if (
    buildState.state !== "stale" ||
    !commit ||
    buildState.buildStampHead !== commit ||
    buildState.runtimePostBuildStampHead !== commit ||
    buildState.missingUiAssets.length > 0 ||
    !commitExists(checkout, commit)
  ) {
    return false;
  }
  try {
    git(checkout, ["merge-base", "--is-ancestor", commit, currentHead]);
    return true;
  } catch {
    return false;
  }
}

function resolveGatewayControlDeployment(checkout, deployment, buildBefore, currentHead) {
  if (!deployment) {
    return null;
  }
  const sourceEntrypoint = path.join(checkout, "dist/index.js");
  if (deployment.entrypoint === sourceEntrypoint) {
    return deployment;
  }
  if (!isTrustedSourceControlBuild(checkout, buildBefore, currentHead)) {
    return null;
  }
  return {
    ...deployment,
    entrypoint: sourceEntrypoint,
    invocationPrefix: deployment.invocationPrefix.map((argument) =>
      argument === deployment.entrypoint ? sourceEntrypoint : argument,
    ),
  };
}

function proveMacLaunchdGatewayStopped(checkout) {
  const { label, port } = readManagedGatewayLaunchAgent(checkout);
  const launchctl = spawnSync(
    "/bin/launchctl",
    ["print", `gui/${process.getuid()}/${label}`],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  const launchctlOutput = `${launchctl.stdout ?? ""}\n${launchctl.stderr ?? ""}`;
  const serviceBootedOut =
    launchctl.status !== 0 && /could not find service|service not found/iu.test(launchctlOutput);
  const processExited =
    serviceBootedOut || (launchctl.status === 0 && !/\bpid\s*=\s*\d+\b/iu.test(launchctlOutput));
  const listeners = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  const listenerClosed =
    listeners.status === 1 && !listeners.stdout.trim() && !listeners.stderr.trim();
  const details = { listenerClosed, processExited, serviceBootedOut };
  if (!serviceBootedOut) {
    throw new UpdateInvariantError(
      "gateway_not_proven_stopped",
      "managed Gateway LaunchAgent is still loaded or its bootout state is ambiguous",
      details,
    );
  }
  if (!listenerClosed) {
    throw new UpdateInvariantError(
      "gateway_not_proven_stopped",
      `Gateway port ${port} is listening or could not be inspected conclusively`,
      details,
    );
  }
  return {
    runtimeStatus: "stopped",
    port,
    portStatus: "free",
    proofSource: "launchd",
    ...details,
  };
}

function defaultProveGatewayStopped(checkout) {
  if (process.platform === "darwin") {
    return proveMacLaunchdGatewayStopped(checkout);
  }
  let result;
  try {
    result = JSON.parse(
      execFileSync(process.execPath, ["dist/index.js", "gateway", "status", "--json"], {
        cwd: checkout,
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: COMMAND_TIMEOUT_MS.gatewayProbe,
      }),
    );
  } catch (error) {
    const commandError =
      error instanceof UpdateCommandError ? error : new UpdateCommandError("gateway.status", error);
    throw new UpdateInvariantError(
      "gateway_stopped_proof_failed",
      "could not inspect the managed Gateway after suspension failed",
      undefined,
      { cause: commandError },
    );
  }
  const runtime = result?.service?.runtime;
  const port = result?.port;
  if (
    runtime?.status !== "stopped" ||
    runtime.pid != null ||
    port?.status !== "free" ||
    !Array.isArray(port.listeners) ||
    port.listeners.length > 0 ||
    result?.rpc?.ok === true
  ) {
    throw new UpdateInvariantError(
      "gateway_not_proven_stopped",
      `managed Gateway is not conclusively stopped: ${JSON.stringify({
        runtimeStatus: runtime?.status ?? null,
        runtimePid: runtime?.pid ?? null,
        portStatus: port?.status ?? null,
        listenerCount: Array.isArray(port?.listeners) ? port.listeners.length : null,
        rpcOk: result?.rpc?.ok ?? null,
      })}`,
    );
  }
  return {
    runtimeStatus: runtime.status,
    port: port.port ?? null,
    portStatus: port.status,
  };
}

function assertExactBuild(checkout, expectedSha) {
  const state = inspectBuildState(checkout, expectedSha);
  if (!state.current) {
    throw new UpdateInvariantError(
      "build_sha_mismatch",
      `build output does not match ${expectedSha}; state=${state.state}`,
    );
  }
  return state;
}

function isOriginalMacBundle(bundlePath, originalStat) {
  try {
    const currentStat = lstatSync(bundlePath);
    return (
      currentStat.isDirectory() &&
      !currentStat.isSymbolicLink() &&
      currentStat.dev === originalStat.dev &&
      currentStat.ino === originalStat.ino
    );
  } catch {
    return false;
  }
}

async function runBuildWithPreservedMacApp(
  runCommand,
  checkout,
  sleep = defaultSleep,
  serviceState = "stopped",
) {
  const appBundle = path.join(checkout, "dist/OpenClaw.app");
  if (!existsSync(appBundle)) {
    await runUpdateCommand(runCommand, "build", "pnpm", ["build"], checkout, {
      phase: "Gateway build",
      serviceState,
      timeoutMs: COMMAND_TIMEOUT_MS.gatewayBuild,
    });
    return;
  }
  const appStat = lstatSync(appBundle);
  if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
    throw new UpdateInvariantError(
      "unsafe_mac_bundle",
      `refusing to preserve unsafe Mac app bundle: ${appBundle}`,
    );
  }
  const preservedBundle = path.join(
    checkout,
    ".git",
    `.openclaw-live-mac-${process.pid}-${randomUUID()}.app`,
  );
  renameSync(appBundle, preservedBundle);
  let buildFailed = false;
  let buildError;
  try {
    await runUpdateCommand(runCommand, "build", "pnpm", ["build"], checkout, {
      phase: "Gateway build",
      serviceState,
      timeoutMs: COMMAND_TIMEOUT_MS.gatewayBuild,
    });
  } catch (error) {
    buildFailed = true;
    buildError = error;
  }
  // Restore outside `finally` so restoration failures retain precedence over build failures.
  // Accept an external restore only when the original inode returns; replacements still fail closed.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (existsSync(preservedBundle) || existsSync(appBundle)) {
      break;
    }
    await sleep(100);
  }
  const alreadyRestored = isOriginalMacBundle(appBundle, appStat);
  if (!alreadyRestored && existsSync(appBundle)) {
    throw new UpdateInvariantError(
      "mac_bundle_restore_conflict",
      `build unexpectedly created ${appBundle}; preserved bundle remains at ${preservedBundle}`,
    );
  }
  if (!alreadyRestored) {
    mkdirSync(path.dirname(appBundle), { recursive: true });
    try {
      renameSync(preservedBundle, appBundle);
    } catch (error) {
      if (!isOriginalMacBundle(appBundle, appStat)) {
        if (existsSync(appBundle)) {
          throw new UpdateInvariantError(
            "mac_bundle_restore_conflict",
            `build unexpectedly created ${appBundle}; preserved bundle remains at ${preservedBundle}`,
          );
        }
        if (existsSync(preservedBundle)) {
          throw new UpdateInvariantError(
            "mac_bundle_restore_failed",
            `failed to restore Mac app bundle: ${String(error)}`,
          );
        }
        throw new UpdateInvariantError(
          "missing_preserved_mac_bundle",
          `preserved Mac app bundle disappeared: ${preservedBundle}`,
        );
      }
    }
  }
  if (!isOriginalMacBundle(appBundle, appStat)) {
    throw new UpdateInvariantError(
      "missing_preserved_mac_bundle",
      `original Mac app bundle was not restored to ${appBundle}`,
    );
  }
  if (existsSync(preservedBundle)) {
    throw new UpdateInvariantError(
      "mac_bundle_restore_conflict",
      `original Mac app bundle exists at both ${appBundle} and ${preservedBundle}`,
    );
  }
  if (buildFailed) {
    throwPreservingValue(buildError);
  }
}

async function restartGateway(
  runCommand,
  checkout,
  expectedSha,
  startedAtMs = Date.now(),
  deployment = null,
  bootstrap = false,
  options = {},
) {
  assertExactBuild(checkout, expectedSha);
  if (!deployment) {
    await runUpdateCommand(
      runCommand,
      "gateway.restart",
      "pnpm",
      ["openclaw", "gateway", "restart"],
      checkout,
      {
        phase: "Gateway restart",
        serviceState: "stopped",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
      },
    );
    return { processStartedAt: null, restartStartedAtMs: startedAtMs };
  }
  if (bootstrap) {
    return {
      ...(await bootstrapManagedGateway(runCommand, checkout, deployment, {
        ...options,
        startupTrace: true,
      })),
      restartStartedAtMs: startedAtMs,
    };
  }
  const assertOwnership =
    options.assertNoSystemLaunchDaemonOwnership ?? assertNoSystemLaunchDaemonOwnership;
  await assertOwnership(deployment.label);
  await runUpdateCommand(
    runCommand,
    "gateway.restart",
    deployment.executable,
    [...deployment.invocationPrefix, "gateway", "restart"],
    path.dirname(path.dirname(deployment.entrypoint)),
    {
      phase: "managed Gateway restart",
      serviceState: "stopped",
      timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
    },
  );
  return { processStartedAt: null, restartStartedAtMs: startedAtMs };
}

async function bootstrapManagedGateway(runCommand, checkout, deployment, options = {}) {
  const plistStat = lstatSync(deployment.plistPath);
  if (!isTrustedOwnedRegularFile(plistStat)) {
    throw new UpdateInvariantError(
      "gateway_launchagent_failed",
      "managed Gateway LaunchAgent ownership or permissions changed before bootstrap",
    );
  }
  const assertOwnership =
    options.assertNoSystemLaunchDaemonOwnership ?? assertNoSystemLaunchDaemonOwnership;
  await assertOwnership(deployment.label);
  const domain = `gui/${process.getuid()}`;
  const serviceTarget = `${domain}/${deployment.label}`;
  const waitForProcess = options.waitForProcess ?? waitForManagedGatewayProcess;
  const now = options.now ?? Date.now;
  if (!options.startupTrace) {
    await runUpdateCommand(
      runCommand,
      "launchd.enable",
      "/bin/launchctl",
      ["enable", serviceTarget],
      checkout,
      {
        phase: "Gateway LaunchAgent enable",
        serviceState: "stopped",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
      },
    );
    await bootstrapLaunchAgentAndWait(
      runCommand,
      checkout,
      deployment,
      domain,
      waitForProcess,
      options.sleep ?? defaultSleep,
    );
    return { processStartedAt: timestampAt(now) };
  }

  const readLaunchdEnvironment = options.readLaunchdEnvironment ?? readLaunchdEnvironmentVariable;
  const armEnvironmentRestore = options.armEnvironmentRestore ?? armLaunchdEnvironmentRestore;
  const previousTraceValue = await readLaunchdEnvironment(GATEWAY_STARTUP_TRACE_ENV);
  const environmentRestore = armEnvironmentRestore(GATEWAY_STARTUP_TRACE_ENV, previousTraceValue);
  let restartError;
  let processStartedAt = null;
  await runUpdateCommand(
    runCommand,
    "launchd.setenv",
    "/bin/launchctl",
    ["setenv", GATEWAY_STARTUP_TRACE_ENV, "1"],
    checkout,
    {
      phase: "Gateway startup trace enable",
      serviceState: "stopped",
      timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
    },
  );
  try {
    await runUpdateCommand(
      runCommand,
      "launchd.enable",
      "/bin/launchctl",
      ["enable", serviceTarget],
      checkout,
      {
        phase: "Gateway LaunchAgent enable",
        serviceState: "stopped",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
      },
    );
    await bootstrapLaunchAgentAndWait(
      runCommand,
      checkout,
      deployment,
      domain,
      waitForProcess,
      options.sleep ?? defaultSleep,
    );
    processStartedAt = timestampAt(now);
  } catch (error) {
    restartError = error;
  }
  try {
    // The booted process already inherited the trace flag. Restore launchd's
    // previous value immediately so later starts keep the host's normal config.
    await runUpdateCommand(
      runCommand,
      previousTraceValue === null ? "launchd.unsetenv" : "launchd.setenv",
      "/bin/launchctl",
      previousTraceValue === null
        ? ["unsetenv", GATEWAY_STARTUP_TRACE_ENV]
        : ["setenv", GATEWAY_STARTUP_TRACE_ENV, previousTraceValue],
      checkout,
      {
        phase: "Gateway startup trace restore",
        serviceState: "running",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
      },
    );
  } catch (cleanupError) {
    if (restartError) {
      throw aggregateErrorWithCause(
        [
          { role: "primary", error: restartError },
          { role: "cleanup", error: cleanupError },
        ],
        "Gateway restart failed and the one-shot startup trace environment could not be cleared",
        cleanupError,
      );
    }
    throw cleanupError;
  }
  environmentRestore.disarm();
  if (restartError) {
    throwPreservingValue(restartError);
  }
  return { processStartedAt };
}

async function bootstrapLaunchAgentAndWait(
  runCommand,
  checkout,
  deployment,
  domain,
  waitForProcess,
  sleep,
) {
  try {
    await runUpdateCommand(
      runCommand,
      "launchd.bootstrap",
      "/bin/launchctl",
      ["bootstrap", domain, deployment.plistPath],
      checkout,
      {
        phase: "Gateway LaunchAgent bootstrap",
        serviceState: "stopped",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayService,
      },
    );
  } catch (bootstrapError) {
    if (findUnsafeCommandCleanupFailure(bootstrapError)) {
      throwPreservingValue(bootstrapError);
    }
    try {
      await waitForProcess(deployment, sleep);
      return;
    } catch {
      throwPreservingValue(bootstrapError);
    }
  }
  await waitForProcess(deployment, sleep);
}

function armLaunchdEnvironmentRestore(name, previousValue) {
  const markerPath = path.join(
    tmpdir(),
    `.openclaw-launchd-env-restore-${process.pid}-${randomUUID()}`,
  );
  writeFileSync(markerPath, "armed\n", { flag: "wx", mode: 0o600 });
  const restoreScript = `
marker="$1"
parent_pid="$2"
name="$3"
mode="$4"
value="$5"
while [ -e "$marker" ] && kill -0 "$parent_pid" >/dev/null 2>&1; do
  sleep 0.1
done
if [ ! -e "$marker" ]; then
  exit 0
fi
if [ "$mode" = "set" ]; then
  /bin/launchctl setenv "$name" "$value"
else
  /bin/launchctl unsetenv "$name"
fi
/bin/rm -f "$marker"
`;
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      restoreScript,
      "openclaw-launchd-env-restore",
      markerPath,
      String(process.pid),
      name,
      previousValue === null ? "unset" : "set",
      previousValue ?? "",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return {
    disarm() {
      rmSync(markerPath, { force: true });
    },
  };
}

function readLaunchdEnvironmentVariable(name) {
  const result = spawnSync(
    "/bin/launchctl",
    ["getenv", name],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  if (result.error || result.status !== 0) {
    throw new UpdateInvariantError(
      "gateway_restart_failed",
      `could not read launchd environment ${name}`,
    );
  }
  // launchd normalizes `setenv NAME ""` to the same absent manager state as
  // `unsetenv NAME`; both `getenv` and `print gui/$UID` omit the value.
  const value = result.stdout.replace(/\r?\n$/u, "");
  return value || null;
}

async function waitForManagedGatewayProcess(deployment, sleep = defaultSleep) {
  const target = `gui/${process.getuid()}/${deployment.label}`;
  const attempts =
    Math.ceil(GATEWAY_PROCESS_START_TIMEOUT_MS / GATEWAY_PROCESS_START_RETRY_DELAY_MS) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = spawnSync(
      "/bin/launchctl",
      ["print", target],
      boundedSyncOptions({ encoding: "utf8" }),
    );
    if (result.status === 0 && /\bpid\s*=\s*\d+\b/iu.test(result.stdout)) {
      return;
    }
    if (attempt + 1 < attempts) {
      await sleep(GATEWAY_PROCESS_START_RETRY_DELAY_MS);
    }
  }
  throw new UpdateInvariantError(
    "gateway_restart_failed",
    "launchd registered the replacement Gateway but did not report a process",
  );
}

function isManagedGatewayLoaded(deployment) {
  const result = spawnSync(
    "/bin/launchctl",
    ["print", `gui/${process.getuid()}/${deployment.label}`],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  return result.status === 0;
}

async function waitForManagedGatewayReadiness(
  deployment,
  probeMilestones = probeGatewayMilestones,
  sleep = defaultSleep,
) {
  for (let attempt = 1; attempt <= GATEWAY_READINESS_ATTEMPTS; attempt += 1) {
    if ((await Promise.resolve(probeMilestones(deployment)))?.readyzReady) {
      return;
    }
    if (attempt < GATEWAY_READINESS_ATTEMPTS) {
      await sleep(GATEWAY_READINESS_RETRY_DELAY_MS);
    }
  }
  throw new UpdateInvariantError(
    "gateway_recovery_failed",
    "the previous managed Gateway did not become ready after rollback",
  );
}

export function isGatewayProbeResponse(route, payload) {
  return route === "/readyz"
    ? payload?.ready === true
    : payload?.ok === true && payload.status === "live";
}

function probeGatewayHttp(port, route) {
  for (const scheme of ["http", "https"]) {
    const result = spawnSync(
      "/usr/bin/curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--insecure",
        "--max-time",
        "1",
        `${scheme}://127.0.0.1:${port}${route}`,
      ],
      boundedSyncOptions({ encoding: "utf8" }, 5_000),
    );
    if (result.status !== 0) {
      continue;
    }
    try {
      const payload = JSON.parse(result.stdout);
      if (isGatewayProbeResponse(route, payload)) {
        return true;
      }
    } catch {
      // Try the alternate loopback protocol.
    }
  }
  return false;
}

function probeGatewayMilestones(deployment) {
  const listeners = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${deployment.port}`, "-sTCP:LISTEN", "-t"],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  const listenerReady = listeners.status === 0 && Boolean(listeners.stdout.trim());
  if (!listenerReady) {
    return { listenerReady: false, healthzReady: false, readyzReady: false };
  }
  const healthzReady = probeGatewayHttp(deployment.port, "/healthz");
  return {
    listenerReady,
    healthzReady,
    readyzReady: healthzReady && probeGatewayHttp(deployment.port, "/readyz"),
  };
}

function channelConnected(summary, channelId) {
  const channel = summary?.channels?.[channelId];
  if (!channel || typeof channel !== "object") {
    return false;
  }
  if (channel.connected === true) {
    return true;
  }
  return Object.values(channel.accounts ?? {}).some((account) => account?.connected === true);
}

function recordGatewayTimestamp(timing, key, at, semantics = "observed") {
  if (timing[key]) {
    return;
  }
  timing[key] = at;
  timing.timestampSemantics ??= {};
  timing.timestampSemantics[key] = semantics;
}

function markGatewayMilestones(timing, observation, observedAt, deepRpcUpperBoundAt = null) {
  if (!observation) {
    return;
  }
  if (observation.listenerReady) {
    recordGatewayTimestamp(
      timing,
      "listenerReadyAt",
      deepRpcUpperBoundAt ?? observedAt,
      deepRpcUpperBoundAt ? "no-later-than" : "observed",
    );
  }
  if (observation.healthzReady) {
    recordGatewayTimestamp(
      timing,
      "healthzReadyAt",
      deepRpcUpperBoundAt ?? observedAt,
      deepRpcUpperBoundAt ? "no-later-than" : "observed",
    );
  }
  if (observation.readyzReady) {
    recordGatewayTimestamp(timing, "readyzReadyAt", observedAt);
  }
}

async function verifyGatewayDeepRpc(runCommand, checkout, expectedSha, deployment, now) {
  assertExactBuild(checkout, expectedSha);
  if (deployment) {
    runBuiltGatewayCli(
      checkout,
      ["gateway", "status", "--deep", "--require-rpc", "--json"],
      deployment,
    );
  } else {
    await runUpdateCommand(
      runCommand,
      "gateway.status",
      "pnpm",
      ["openclaw", "gateway", "status", "--deep", "--require-rpc", "--json"],
      checkout,
      {
        phase: "Gateway deep status probe",
        serviceState: "running",
        timeoutMs: COMMAND_TIMEOUT_MS.gatewayProbe,
      },
    );
  }
  return timestampAt(now);
}

async function readGatewayHealth(runCommand, checkout, deployment) {
  if (deployment) {
    const healthOutput = runBuiltGatewayCli(
      checkout,
      ["health", "--verbose", "--json"],
      deployment,
    );
    let healthSummary;
    try {
      healthSummary = JSON.parse(healthOutput);
    } catch (error) {
      throw new UpdateInvariantError(
        "gateway_health_invalid",
        `Gateway health probe did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return healthSummary;
  }
  await runUpdateCommand(
    runCommand,
    "gateway.health",
    "pnpm",
    ["openclaw", "health", "--verbose", "--json"],
    checkout,
    {
      phase: "Gateway health probe",
      serviceState: "running",
      timeoutMs: COMMAND_TIMEOUT_MS.gatewayProbe,
    },
  );
  return null;
}

async function verifyGateway(runCommand, checkout, expectedSha, deployment = null, now = Date.now) {
  const deepRpcReadyAt = await verifyGatewayDeepRpc(
    runCommand,
    checkout,
    expectedSha,
    deployment,
    now,
  );
  return {
    deepRpcReadyAt,
    healthSummary: await readGatewayHealth(runCommand, checkout, deployment),
  };
}

function defaultSleep(ms) {
  return delay(ms);
}

/**
 * @param {(command: string, args: string[], checkout: string, options?: Record<string, unknown>) => void | Promise<void>} runCommand
 * @param {string} checkout
 * @param {string} expectedSha
 * @param {(ms: number) => void | Promise<void>} [sleep]
 * @param {GatewayCliDeployment | null} [deployment]
 * @param {{
 *   now?: () => number,
 *   probeMilestones?: (deployment: GatewayCliDeployment) => {
 *     listenerReady: boolean,
 *     healthzReady: boolean,
 *     readyzReady: boolean,
 *   },
 *   timing?: Record<string, unknown>,
 * }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function verifyGatewayReadiness(
  runCommand,
  checkout,
  expectedSha,
  sleep = defaultSleep,
  deployment = null,
  options = {},
) {
  const now = options.now ?? Date.now;
  const probeMilestones = options.probeMilestones ?? probeGatewayMilestones;
  const timing = options.timing ?? {
    listenerReadyAt: null,
    healthzReadyAt: null,
    readyzReadyAt: null,
    deepRpcReadyAt: null,
    discordConnectedAt: null,
    telegramConnectedAt: null,
    timestampSemantics: {},
  };
  let lastError;
  for (let attempt = 1; attempt <= GATEWAY_READINESS_ATTEMPTS; attempt += 1) {
    try {
      if (deployment) {
        markGatewayMilestones(timing, probeMilestones(deployment), timestampAt(now));
      }
      const deepRpcReadyAt = await verifyGatewayDeepRpc(
        runCommand,
        checkout,
        expectedSha,
        deployment,
        now,
      );
      recordGatewayTimestamp(timing, "deepRpcReadyAt", deepRpcReadyAt);
      if (deployment) {
        markGatewayMilestones(
          timing,
          probeMilestones(deployment),
          timestampAt(now),
          deepRpcReadyAt,
        );
      }
      const healthSummary = await readGatewayHealth(runCommand, checkout, deployment);
      if (channelConnected(healthSummary, "discord")) {
        recordGatewayTimestamp(timing, "discordConnectedAt", timestampAt(now));
      }
      if (channelConnected(healthSummary, "telegram")) {
        recordGatewayTimestamp(timing, "telegramConnectedAt", timestampAt(now));
      }
      return timing;
    } catch (error) {
      lastError = error;
      if (attempt < GATEWAY_READINESS_ATTEMPTS) {
        await sleep(GATEWAY_READINESS_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function summarizeGatewayLogEntry(entry) {
  return {
    time: entry.time,
    level: entry.level,
    subsystem: entry.subsystem ?? null,
    message: String(entry.message ?? "").slice(0, 500),
  };
}

function canonicalizeExistingPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathWithinRoot(sourcePath, rootPath) {
  const normalizedRoot = canonicalizeExistingPath(rootPath);
  const normalizedSource = canonicalizeExistingPath(sourcePath);
  return (
    normalizedSource === normalizedRoot ||
    normalizedSource.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function isCurrentGatewayLogSource(source, sourceRoot, managedSourceRoots) {
  if (managedSourceRoots === null) {
    return true;
  }
  if (!sourceRoot) {
    return true;
  }
  if (typeof source !== "string" || source.length === 0) {
    return true;
  }
  let sourcePath;
  try {
    sourcePath = source.startsWith("file:") ? fileURLToPath(source) : source;
  } catch {
    return true;
  }
  const sourceFilePath = sourcePath.replace(/:\d+(?::\d+)?$/u, "");
  if (sourceFilePath !== sourcePath && !existsSync(sourcePath) && existsSync(sourceFilePath)) {
    sourcePath = sourceFilePath;
  }
  if (
    isPathWithinRoot(sourcePath, sourceRoot) ||
    managedSourceRoots.some((rootPath) => isPathWithinRoot(sourcePath, rootPath))
  ) {
    return true;
  }
  const normalizedRoot = canonicalizeExistingPath(sourceRoot);
  const normalizedSource = canonicalizeExistingPath(sourcePath);
  const checkoutRoot = path.dirname(normalizedRoot);
  let candidate = path.dirname(normalizedSource);
  while (candidate !== path.dirname(candidate)) {
    const packagePath = path.join(candidate, "package.json");
    const gitPath = path.join(candidate, ".git");
    if (existsSync(packagePath) && existsSync(gitPath)) {
      try {
        if (JSON.parse(readFileSync(packagePath, "utf8")).name === "openclaw") {
          return candidate === checkoutRoot;
        }
      } catch {
        return true;
      }
    }
    candidate = path.dirname(candidate);
  }
  return true;
}

function parseGatewayLogEntries(output, sinceMs) {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const raw = JSON.parse(line);
        let sourceRecord = raw;
        if (raw.type === "log" && typeof raw.raw === "string") {
          try {
            sourceRecord = JSON.parse(raw.raw);
          } catch {
            sourceRecord = raw;
          }
        }
        const rawLevel = raw.type === "log" ? raw.level : raw._meta?.logLevelName;
        const level = String(rawLevel ?? "").toLowerCase();
        const time = raw.time ?? raw._meta?.date;
        const timestamp = Date.parse(time ?? "");
        if (!level || !Number.isFinite(timestamp) || timestamp < sinceMs) {
          return [];
        }
        let subsystem = raw.subsystem ?? null;
        if (!subsystem && typeof raw["0"] === "string") {
          try {
            subsystem = JSON.parse(raw["0"]).subsystem ?? null;
          } catch {
            subsystem = null;
          }
        }
        return [
          {
            time,
            level,
            subsystem,
            message: raw.message ?? raw["1"] ?? raw["0"] ?? "",
            source: sourceRecord._meta?.path?.fullFilePath ?? null,
          },
        ];
      } catch {
        return [];
      }
    });
}

function summarizeGatewayLogAudit(entries) {
  const errors = entries
    .filter((entry) => entry.level === "error" || entry.level === "fatal")
    .map(summarizeGatewayLogEntry);
  const warnings = entries.filter((entry) => entry.level === "warn").map(summarizeGatewayLogEntry);
  const startupTrace = entries
    .filter((entry) => String(entry.message ?? "").includes("startup trace:"))
    .map(summarizeGatewayLogEntry)
    .slice(0, 100);
  return {
    entries: entries.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 20),
    ...(startupTrace.length > 0 ? { startupTrace } : {}),
  };
}

/**
 * @param {string} output
 * @param {number} sinceMs
 * @param {string | null} [sourceRoot]
 * @param {string[] | null} [managedSourceRoots]
 */
export function parseGatewayLogAudit(output, sinceMs, sourceRoot = null, managedSourceRoots = []) {
  const entries = parseGatewayLogEntries(output, sinceMs).filter((entry) =>
    isCurrentGatewayLogSource(entry.source, sourceRoot, managedSourceRoots),
  );
  return summarizeGatewayLogAudit(entries);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readFallbackGatewayLogs(sinceMs) {
  const dates = new Set([localDateKey(new Date(sinceMs)), localDateKey(new Date())]);
  const directories = new Set(["/tmp/openclaw", path.join(tmpdir(), "openclaw")]);
  const contents = [];
  for (const directory of directories) {
    for (const date of dates) {
      const logPath = path.join(directory, `openclaw-${date}.log`);
      if (existsSync(logPath)) {
        contents.push(readFileSync(logPath, "utf8"));
      }
    }
  }
  return contents.join("\n");
}

function readManagedPluginSourceRoots(checkout, deployment) {
  let managedDeployment = deployment;
  try {
    managedDeployment ??= readManagedGatewayLaunchAgent(checkout);
  } catch {
    return null;
  }
  try {
    const output = runBuiltGatewayCli(
      checkout,
      ["plugins", "list", "--enabled", "--json"],
      managedDeployment,
      { stderr: "pipe" },
    );
    return resolveManagedPluginSourceRoots(JSON.parse(output));
  } catch {
    return null;
  }
}

export function resolveManagedPluginSourceRoots(report) {
  if (!Array.isArray(report?.plugins)) {
    return null;
  }
  const roots = [];
  for (const plugin of report.plugins) {
    if (typeof plugin?.rootDir !== "string" || plugin.rootDir.length === 0) {
      return null;
    }
    roots.push(plugin.rootDir);
  }
  return roots;
}

/**
 * @param {string} checkout
 * @param {GatewayDeploymentRef | null | undefined} deployment
 */
export function resolveManagedGatewaySourceRoot(checkout, deployment) {
  return typeof deployment?.entrypoint === "string" && deployment.entrypoint.length > 0
    ? path.dirname(path.resolve(deployment.entrypoint))
    : path.join(realpathSync(checkout), "dist");
}

function defaultAuditGatewayLogs(checkout, sinceMs, deployment = null) {
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [
        "openclaw.mjs",
        "logs",
        "--json",
        "--limit",
        "1000",
        "--max-bytes",
        "1000000",
        "--timeout",
        "10000",
      ],
      boundedSyncOptions({
        cwd: checkout,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  } catch (error) {
    output = readFallbackGatewayLogs(sinceMs);
    if (!output) {
      throw error;
    }
  }
  const audit = parseGatewayLogAudit(
    output,
    sinceMs,
    resolveManagedGatewaySourceRoot(checkout, deployment),
    readManagedPluginSourceRoots(checkout, deployment),
  );
  if (audit.errorCount > 0) {
    throw new UpdateInvariantError(
      "gateway_restart_log_errors",
      `Gateway emitted ${audit.errorCount} error/fatal log entries after restart: ${JSON.stringify(audit.errors.slice(0, 5))}`,
    );
  }
  return audit;
}

async function verifyAndAuditGateway({
  runCommand,
  auditGatewayLogs,
  checkout,
  expectedSha,
  deployment,
  sinceMs,
  sleep,
  timing,
  now,
  probeMilestones,
}) {
  let verificationError;
  let gatewayTiming = timing;
  try {
    gatewayTiming = await verifyGatewayReadiness(
      runCommand,
      checkout,
      expectedSha,
      sleep,
      deployment,
      {
        timing,
        now,
        probeMilestones,
      },
    );
  } catch (error) {
    verificationError = error;
  }
  const audit = await auditGatewayLogs(checkout, sinceMs, deployment);
  if (verificationError) {
    throwPreservingValue(verificationError);
  }
  return { audit, timing: gatewayTiming };
}

function finalizeGatewayTiming(timing) {
  if (!timing) {
    return null;
  }
  const deepRpcReadyMs = Date.parse(timing.deepRpcReadyAt ?? "");
  const listenerClosedMs = Date.parse(timing.listenerClosedAt ?? "");
  const processStartedMs = Date.parse(timing.processStartedAt ?? "");
  // Both endpoints are observed after their underlying events. Their
  // independent observation delays make these useful estimates, not bounds.
  return {
    ...timing,
    totalOutageMs:
      Number.isFinite(deepRpcReadyMs) && Number.isFinite(listenerClosedMs)
        ? Math.max(0, deepRpcReadyMs - listenerClosedMs)
        : null,
    coldStartMs:
      Number.isFinite(deepRpcReadyMs) && Number.isFinite(processStartedMs)
        ? Math.max(0, deepRpcReadyMs - processStartedMs)
        : null,
    durationSemantics: {
      totalOutageMs: "observed-estimate",
      coldStartMs: "observed-estimate",
    },
  };
}

export function findExactMacTarget(processes, executable) {
  const target = processes
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/u))
    .find((match) => match && (match[2] === executable || match[2].startsWith(`${executable} `)));
  return target ? { executable, pid: Number(target[1]) } : null;
}

async function defaultVerifyMacTarget(checkout) {
  await delay(10_000);
  const executable = path.join(checkout, "dist/OpenClaw.app/Contents/MacOS/OpenClaw");
  const processes = execFileSync(
    "ps",
    ["axww", "-o", "pid=,command="],
    boundedSyncOptions({ encoding: "utf8" }),
  );
  const target = findExactMacTarget(processes, executable);
  if (!target) {
    throw new UpdateInvariantError(
      "mac_target_not_alive",
      `exact target bundle exited after delayed verification: ${executable}`,
    );
  }
  return target;
}

/**
 * @overload
 * @param {Record<string, unknown>} options
 * @param {Record<string, unknown>} [dependencies]
 * @returns {Promise<UpdateResult>}
 */
export async function maintainMain(options, dependencies = {}) {
  const lock = acquireMaintenanceLock(options.checkout, options.lockPath);
  if (!lock.acquired) {
    return {
      schemaVersion: 1,
      ok: true,
      skipped: true,
      reason: "overlap",
      lock: {
        path: lock.lockPath,
        ownerPid: lock.owner.pid,
        startedAt: lock.owner.startedAt,
        ...(Number.isInteger(lock.owner.processGroupId)
          ? { processGroupId: lock.owner.processGroupId }
          : {}),
        ...(lock.owner.manualRecoveryRequired === true ? { manualRecoveryRequired: true } : {}),
        ...(typeof lock.owner.processTreeState === "string"
          ? { processTreeState: lock.owner.processTreeState }
          : {}),
        ...(typeof lock.owner.reason === "string" ? { reason: lock.owner.reason } : {}),
      },
    };
  }

  let preparedGatewayReplacement = null;
  let retainMaintenanceLock = false;
  try {
    const verifiedBefore = verifyCheckout(options.checkout, { remote: options.remote });
    const managedCommand = (command, args, checkout, commandOptions = {}) =>
      defaultRunCommand(command, args, checkout, {
        ...commandOptions,
        runManagedCommand: dependencies.runManagedCommand,
      });
    const runCommand = dependencies.runCommand ?? managedCommand;
    const inspectGatewayDeployment =
      dependencies.inspectGatewayDeployment ?? inspectManagedGatewayDeployment;
    const repointGatewayDeployment =
      dependencies.repointGatewayDeployment ?? repointManagedGatewayDeployment;
    const replaceGatewayEntrypoint =
      dependencies.replaceGatewayEntrypoint ?? replaceLaunchAgentEntrypoint;
    const assertSystemOwnership =
      dependencies.assertNoSystemLaunchDaemonOwnership ?? assertNoSystemLaunchDaemonOwnership;
    const prepareGatewayEntrypointReplacement =
      dependencies.prepareGatewayEntrypointReplacement ??
      ((deployment, entrypoint) =>
        dependencies.replaceGatewayEntrypoint
          ? {
              install: () => replaceGatewayEntrypoint(deployment, entrypoint),
              discard() {},
            }
          : prepareLaunchAgentEntrypointReplacement(deployment, entrypoint, {
              assertNoSystemLaunchDaemonOwnership: assertSystemOwnership,
            }));
    const verifyGatewayRuntime = dependencies.verifyGatewayRuntime ?? verifyManagedGatewayRuntime;
    const verifyGatewayProbe = dependencies.verifyGateway ?? verifyGateway;
    const verifyGatewayAfterRestart = dependencies.verifyAndAuditGateway ?? verifyAndAuditGateway;
    const restartManagedGateway = dependencies.restartGateway ?? restartGateway;
    const isGatewayLoaded = dependencies.isGatewayLoaded ?? isManagedGatewayLoaded;
    const prepareSuspension =
      dependencies.prepareGatewaySuspension ??
      ((checkout, deployment) =>
        prepareGatewaySuspension(checkout, runBuiltGatewayCall, deployment));
    const resumeSuspension = dependencies.resumeGatewaySuspension ?? defaultResumeGatewaySuspension;
    const proveGatewayStopped = dependencies.proveGatewayStopped ?? defaultProveGatewayStopped;
    const verifyMacTarget = dependencies.verifyMacTarget ?? defaultVerifyMacTarget;
    const auditGatewayLogs = dependencies.auditGatewayLogs ?? defaultAuditGatewayLogs;
    const sleep = dependencies.sleep ?? defaultSleep;
    const now = dependencies.now ?? Date.now;
    const probeMilestones = dependencies.probeGatewayMilestones ?? probeGatewayMilestones;
    const waitForGatewayProcess =
      dependencies.waitForGatewayProcess ?? waitForManagedGatewayProcess;
    const readLaunchdEnvironment =
      dependencies.readLaunchdEnvironment ?? readLaunchdEnvironmentVariable;
    const armEnvironmentRestore =
      dependencies.armEnvironmentRestore ?? armLaunchdEnvironmentRestore;
    const gatewayDeploymentBefore = await inspectGatewayDeployment(verifiedBefore.checkout);
    const sourceBuildBeforeUpdate = inspectBuildState(
      verifiedBefore.checkout,
      verifiedBefore.headSha,
    );
    let gatewayControlDeployment = resolveGatewayControlDeployment(
      verifiedBefore.checkout,
      gatewayDeploymentBefore,
      sourceBuildBeforeUpdate,
      verifiedBefore.headSha,
    );
    const update = await updateMain(options, managedCommand, dependencies);
    const statePath = options.statePath ?? defaultStatePath(update.checkout);
    const maintenanceState = readMaintenanceState(statePath);
    const buildBefore = inspectBuildState(update.checkout, update.afterSha);
    const buildRequired = update.updated || !buildBefore.current;
    let buildChangedPaths = update.changedPaths;
    const buildBaseExists =
      Boolean(buildBefore.commit) && commitExists(update.checkout, buildBefore.commit);
    if (
      buildRequired &&
      buildBefore.commit &&
      buildBefore.commit !== update.afterSha &&
      buildBaseExists
    ) {
      buildChangedPaths = changedPathsBetween(update.checkout, buildBefore.commit, update.afterSha);
    }
    const actions = classifyActions(buildChangedPaths, {
      buildProvenanceKnown: buildBefore.current || buildBaseExists,
      buildRequired,
      nodeModulesPresent: existsSync(path.join(update.checkout, "node_modules")),
    });
    if (maintenanceState.macPending) {
      actions.macAppRebuild = true;
      actions.macUiVerification ||= maintenanceState.macUiVerification === true;
    }
    const gatewayRuntimeRepointRequired =
      gatewayDeploymentBefore !== null &&
      gatewayDeploymentBefore.entrypoint !== path.join(update.checkout, "dist/index.js");
    let gatewayLogAudit = null;
    let gatewayDeployment = null;
    let gatewayRuntime = null;
    let gatewayTiming = null;
    let queuedMacState = null;
    if (actions.macAppRebuild) {
      queuedMacState = {
        macPending: true,
        macUiVerification: actions.macUiVerification,
        sinceSha: maintenanceState.sinceSha ?? update.afterSha,
        attempts: Number(maintenanceState.attempts ?? 0),
        queuedAt: maintenanceState.queuedAt ?? new Date().toISOString(),
      };
      writeMaintenanceState(statePath, queuedMacState);
    }

    if (actions.gatewayBuild || actions.dependencyInstall || gatewayRuntimeRepointRequired) {
      actions.gatewayRestart = true;
      let controlBuildPrepared = false;
      let controlDependenciesInstalled = false;
      let gatewayStoppedForMaintenance = false;
      let gatewaySuspension;
      const controlUnavailable =
        gatewayDeploymentBefore !== null && gatewayControlDeployment === null;
      if (controlUnavailable) {
        try {
          gatewaySuspension = {
            status: "offline",
            proof: await proveGatewayStopped(update.checkout),
          };
        } catch (proofError) {
          try {
            if (!gatewayRuntimeRepointRequired) {
              throw new UpdateInvariantError(
                "gateway_live_source_build_forbidden",
                "refusing to rebuild the source entrypoint while its managed Gateway is still running",
              );
            }
            // The running Gateway is isolated in its immutable snapshot, so a
            // clean source build cannot mutate its code. Build only to obtain
            // an exact trusted client for the suspension RPC.
            if (actions.dependencyInstall) {
              await runUpdateCommand(
                runCommand,
                "dependencies.install",
                "pnpm",
                ["install", "--frozen-lockfile"],
                update.checkout,
                {
                  phase: "dependency install",
                  serviceState: "running",
                  timeoutMs: COMMAND_TIMEOUT_MS.dependencyInstall,
                },
              );
              controlDependenciesInstalled = true;
            }
            if (!actions.gatewayBuild) {
              throw new UpdateInvariantError(
                "gateway_snapshot_control_unavailable",
                "managed Gateway snapshot has no exact trusted source control build",
              );
            }
            await runBuildWithPreservedMacApp(runCommand, update.checkout, sleep, "running");
            assertExactBuild(update.checkout, update.afterSha);
            controlBuildPrepared = true;
            gatewayControlDeployment = resolveGatewayControlDeployment(
              update.checkout,
              gatewayDeploymentBefore,
              inspectBuildState(update.checkout, update.afterSha),
              update.afterSha,
            );
            if (!gatewayControlDeployment) {
              throw new UpdateInvariantError(
                "gateway_snapshot_control_unavailable",
                "source build did not produce an exact trusted Gateway control client",
              );
            }
            gatewaySuspension = await prepareSuspension(update.checkout, gatewayControlDeployment);
          } catch (controlError) {
            throw aggregateErrorWithCause(
              [
                {
                  role: "context",
                  error: new UpdateInvariantError(
                    "gateway_snapshot_control_unavailable",
                    "managed Gateway uses a snapshot but the source checkout has no exact trusted control build",
                  ),
                },
                { role: "proof", error: proofError },
                { role: "primary", error: controlError },
              ],
              "Gateway control is unavailable and the managed Gateway could not be proven stopped",
              controlError,
            );
          }
        }
      } else {
        try {
          gatewaySuspension = await prepareSuspension(update.checkout, gatewayControlDeployment);
        } catch (prepareError) {
          try {
            gatewaySuspension = {
              status: "offline",
              proof: await proveGatewayStopped(update.checkout),
            };
          } catch (proofError) {
            throw aggregateErrorWithCause(
              [
                { role: "primary", error: prepareError },
                { role: "proof", error: proofError },
              ],
              "Gateway suspension failed and the managed Gateway could not be proven stopped",
              proofError,
            );
          }
        }
      }
      if (gatewaySuspension.status === "busy") {
        return {
          schemaVersion: 1,
          ok: true,
          deferred: true,
          reason: "gateway_active_work",
          ...update,
          buildBefore,
          buildChangedPaths,
          actions,
          gatewaySuspension,
        };
      }
      gatewayStoppedForMaintenance = gatewaySuspension.status === "offline";
      if (gatewaySuspension.status === "ready") {
        // Native bootout prevents launchd from retaining old ProgramArguments
        // and avoids source launchers that can rebuild stale dist before stopping.
        try {
          if (gatewayDeploymentBefore) {
            await assertSystemOwnership(gatewayDeploymentBefore.label);
          }
          if (gatewayRuntimeRepointRequired) {
            // Complete every fallible plist rewrite and validation while the
            // current service is available; publication is one atomic rename.
            preparedGatewayReplacement = prepareGatewayEntrypointReplacement(
              gatewayDeploymentBefore,
              path.join(update.checkout, "dist/index.js"),
            );
          }
          // launchctl can return before the job and listener have disappeared.
          // Retarget only after bounded native proof prevents cached snapshot revival.
          const stopped = await stopManagedGatewayAndProve(
            runCommand,
            update.checkout,
            gatewayDeploymentBefore,
            proveGatewayStopped,
            sleep,
            now,
          );
          gatewayTiming = stopped.timing;
          gatewayStoppedForMaintenance = true;
        } catch (error) {
          try {
            await resumeSuspension(
              update.checkout,
              gatewaySuspension.suspensionId,
              gatewayControlDeployment,
            );
          } catch (resumeError) {
            throw aggregateErrorWithCause(
              [
                { role: "primary", error },
                { role: "rollback", error: resumeError },
              ],
              "Gateway stop failed and the prepared maintenance suspension could not be resumed",
              resumeError,
            );
          }
          throw error;
        }
      }
      try {
        if (actions.dependencyInstall && !controlDependenciesInstalled) {
          await runUpdateCommand(
            runCommand,
            "dependencies.install",
            "pnpm",
            ["install", "--frozen-lockfile"],
            update.checkout,
            {
              phase: "dependency install",
              serviceState: "stopped",
              timeoutMs: COMMAND_TIMEOUT_MS.dependencyInstall,
            },
          );
        }
        if (actions.gatewayBuild && !controlBuildPrepared) {
          await runBuildWithPreservedMacApp(runCommand, update.checkout, sleep);
        }
        assertExactBuild(update.checkout, update.afterSha);
        const restartStartedAt = now();
        if (gatewayDeploymentBefore) {
          await assertSystemOwnership(gatewayDeploymentBefore.label);
        }
        gatewayDeployment = gatewayDeploymentBefore
          ? repointGatewayDeployment(
              update.checkout,
              gatewayDeploymentBefore,
              (deployment, entrypoint) => {
                if (preparedGatewayReplacement) {
                  preparedGatewayReplacement.install();
                  return;
                }
                replaceGatewayEntrypoint(deployment, entrypoint);
              },
              inspectGatewayDeployment,
            )
          : null;
        gatewayTiming = {
          bootoutStartedAt: null,
          bootoutCompletedAt: null,
          processExitedAt: null,
          listenerClosedAt: null,
          listenerReadyAt: null,
          healthzReadyAt: null,
          readyzReadyAt: null,
          deepRpcReadyAt: null,
          discordConnectedAt: null,
          telegramConnectedAt: null,
          ...gatewayTiming,
        };
        const restart = await restartManagedGateway(
          runCommand,
          update.checkout,
          update.afterSha,
          restartStartedAt,
          gatewayDeployment,
          gatewayDeployment !== null,
          {
            now,
            sleep,
            waitForProcess: waitForGatewayProcess,
            readLaunchdEnvironment,
            armEnvironmentRestore,
            assertNoSystemLaunchDaemonOwnership: assertSystemOwnership,
          },
        );
        if (typeof restart?.processStartedAt === "string") {
          recordGatewayTimestamp(gatewayTiming, "processStartedAt", restart.processStartedAt);
        }
        const verification = await verifyGatewayAfterRestart({
          runCommand,
          auditGatewayLogs,
          checkout: update.checkout,
          expectedSha: update.afterSha,
          deployment: gatewayDeployment,
          sinceMs: restartStartedAt,
          sleep,
          timing: gatewayTiming,
          now,
          probeMilestones,
        });
        gatewayLogAudit = verification?.audit ?? verification;
        gatewayTiming = finalizeGatewayTiming(verification?.timing ?? gatewayTiming);
        gatewayRuntime = await verifyGatewayRuntime(update.checkout, update.afterSha);
      } catch (error) {
        if (findUnsafeCommandCleanupFailure(error)) {
          throwPreservingValue(error);
        }
        if (!gatewayStoppedForMaintenance || !gatewayDeploymentBefore) {
          throw error;
        }
        try {
          // A failed bootstrap may still have registered or started the
          // replacement. Bootout is allowed to fail only when native proof
          // independently confirms that no job or listener remains.
          await stopManagedGatewayAndProve(
            runCommand,
            update.checkout,
            gatewayDeploymentBefore,
            proveGatewayStopped,
            sleep,
            now,
          );
          preparedGatewayReplacement?.restore?.();
          await bootstrapManagedGateway(runCommand, update.checkout, gatewayDeploymentBefore, {
            now,
            sleep,
            waitForProcess: waitForGatewayProcess,
            assertNoSystemLaunchDaemonOwnership: assertSystemOwnership,
          });
          await waitForManagedGatewayReadiness(gatewayDeploymentBefore, probeMilestones, sleep);
        } catch (recoveryError) {
          throw aggregateErrorWithCause(
            [
              { role: "primary", error },
              { role: "rollback", error: recoveryError },
            ],
            "Gateway replacement failed and the previous managed service could not be restored",
            recoveryError,
          );
        }
        throw error;
      }
    } else {
      try {
        await verifyGatewayProbe(
          runCommand,
          update.checkout,
          update.afterSha,
          gatewayControlDeployment,
        );
        gatewayRuntime = await verifyGatewayRuntime(update.checkout, update.afterSha);
      } catch {
        actions.gatewayRestart = true;
        actions.gatewaySelfHeal = true;
        const bootstrap =
          gatewayControlDeployment !== null && !(await isGatewayLoaded(gatewayControlDeployment));
        const restartStartedAt = now();
        const restart = await restartManagedGateway(
          runCommand,
          update.checkout,
          update.afterSha,
          restartStartedAt,
          gatewayControlDeployment,
          bootstrap,
          {
            now,
            sleep,
            waitForProcess: waitForGatewayProcess,
            readLaunchdEnvironment,
            armEnvironmentRestore,
            assertNoSystemLaunchDaemonOwnership: assertSystemOwnership,
          },
        );
        gatewayTiming = {
          bootoutStartedAt: null,
          bootoutCompletedAt: null,
          processExitedAt: null,
          listenerClosedAt: null,
          processStartedAt: null,
          listenerReadyAt: null,
          healthzReadyAt: null,
          readyzReadyAt: null,
          deepRpcReadyAt: null,
          discordConnectedAt: null,
          telegramConnectedAt: null,
        };
        if (typeof restart?.processStartedAt === "string") {
          recordGatewayTimestamp(gatewayTiming, "processStartedAt", restart.processStartedAt);
        }
        const verification = await verifyGatewayAfterRestart({
          runCommand,
          auditGatewayLogs,
          checkout: update.checkout,
          expectedSha: update.afterSha,
          deployment: gatewayControlDeployment,
          sinceMs: restartStartedAt,
          sleep,
          timing: gatewayTiming,
          now,
          probeMilestones,
        });
        gatewayLogAudit = verification?.audit ?? verification;
        gatewayTiming = finalizeGatewayTiming(verification?.timing ?? gatewayTiming);
        gatewayRuntime = await verifyGatewayRuntime(update.checkout, update.afterSha);
      }
    }
    if (actions.macAppRebuild) {
      const pendingState = {
        ...queuedMacState,
        attempts: (queuedMacState?.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
      };
      writeMaintenanceState(statePath, pendingState);
      try {
        // The exact-SHA JS build above already produced dist/control-ui. Letting
        // Mac packaging rebuild it can empty dist while the live app bundle is
        // there, defeating the staged-swap guarantee.
        await runUpdateCommand(
          runCommand,
          "mac.restart",
          "env",
          [
            "SKIP_TSC=1",
            "SKIP_UI_BUILD=1",
            "bash",
            "scripts/restart-mac.sh",
            "--sign",
            "--wait",
            "--target-only",
          ],
          update.checkout,
          {
            phase: "Mac app rebuild",
            serviceState: "running",
            timeoutMs: COMMAND_TIMEOUT_MS.macAppRebuild,
          },
        );
        const macTarget = await verifyMacTarget(update.checkout);
        await verifyGatewayProbe(
          runCommand,
          update.checkout,
          update.afterSha,
          gatewayDeployment ?? gatewayControlDeployment,
        );
        rmSync(statePath, { force: true });
        maintenanceState.macTarget = macTarget;
      } catch (error) {
        writeMaintenanceState(statePath, {
          ...pendingState,
          lastFailure: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    return {
      schemaVersion: 1,
      ok: true,
      ...update,
      buildBefore,
      buildChangedPaths,
      actions,
      ...(gatewayDeployment
        ? {
            gatewayDeployment: {
              changed: gatewayDeployment.changed,
              entrypoint: gatewayDeployment.entrypoint,
              label: gatewayDeployment.label,
              port: gatewayDeployment.port,
              ...(gatewayDeployment.previousEntrypoint
                ? { previousEntrypoint: gatewayDeployment.previousEntrypoint }
                : {}),
            },
          }
        : {}),
      ...(gatewayLogAudit ? { gatewayLogAudit } : {}),
      ...(gatewayTiming ? { gatewayTiming } : {}),
      ...(gatewayRuntime ? { gatewayRuntime } : {}),
      ...(maintenanceState.macTarget ? { macTarget: maintenanceState.macTarget } : {}),
    };
  } catch (error) {
    const cleanupFailure = findUnsafeCommandCleanupFailure(error);
    if (cleanupFailure) {
      retainMaintenanceLock = true;
      lock.retainForCleanupFailure(cleanupFailure.details);
      cleanupFailure.details = {
        ...cleanupFailure.details,
        lockPath: lock.lockPath,
        lockRetained: true,
      };
    }
    return throwPreservingValue(error);
  } finally {
    preparedGatewayReplacement?.discard();
    if (!retainMaintenanceLock) {
      lock.release();
    }
  }
}

function parseArgs(argv) {
  const options = { checkout: process.cwd(), remote: "origin" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--checkout") {
      options.checkout = argv[++index];
    } else if (arg === "--remote") {
      options.remote = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: update-main.mjs [--checkout PATH] [--remote NAME]");
      process.exit(0);
    } else {
      throw new UpdateInvariantError("invalid_argument", `unknown argument: ${arg}`);
    }
  }
  if (!options.checkout || !options.remote) {
    throw new UpdateInvariantError("invalid_argument", "option values must be non-empty");
  }
  return options;
}

export async function runLiveUpdaterMain(argv = process.argv.slice(2), dependencies = {}) {
  try {
    console.log(JSON.stringify(await maintainMain(parseArgs(argv), dependencies)));
  } catch (error) {
    console.log(JSON.stringify(formatUpdateFailure(error)));
    process.exitCode = 1;
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  void runLiveUpdaterMain();
}

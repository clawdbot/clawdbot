#!/usr/bin/env node
// Coordinates release-candidate validation runs and emits the publish command
// only after required local, CI, npm, plugin, and E2E evidence is green.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mjs";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import {
  dedicatedSectionVersionForTag,
  extractChangelogReleaseSections,
  extractChangelogSection,
  formatShippedBaselineExclusions,
  parseShippedBaselineExclusions,
  releaseNotesSectionForTag,
  releaseNotesVersionForTag,
  renderGithubReleaseNotes,
} from "./render-github-release-notes.mjs";
import {
  isShaPinnedReleaseValidationBranch,
  runStrictReleaseEvidenceValidation,
  validateFullReleaseValidationEvidence,
} from "./validate-full-release-validation-evidence.mjs";

const DEFAULT_REPO = "openclaw/openclaw";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODE = "both";
const DEFAULT_NPM_DIST_TAG = "beta";
const DEFAULT_PLUGIN_SCOPE = "all-publishable";
const DEFAULT_TELEGRAM_PROVIDER_MODE = "mock-openai";
const DEFAULT_GITHUB_API_TIMEOUT_MS = 30_000;
const DEFAULT_GITHUB_API_RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;
const COMMAND_CAPTURE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TOOLING_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TIDECLAW_ALPHA_WORKFLOW_REF_PATTERN =
  /^tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u;
const WINDOWS_NODE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u;
const WINDOWS_NODE_REPO = "openclaw/openclaw-windows-node";
const WINDOWS_NODE_REQUIRED_ASSETS = [
  "OpenClawCompanion-Setup-x64.exe",
  "OpenClawCompanion-Setup-arm64.exe",
];
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_CANDIDATE_STATE_VERSION = 1;
const RELEASE_CANDIDATE_STATE_FILE = "release-candidate-state.json";
const RELEASE_CANDIDATE_STATE_KEYS = [
  "repo",
  "tag",
  "targetSha",
  "toolingSha",
  "workflowRef",
  "provider",
  "mode",
  "releaseProfile",
  "npmDistTag",
  "pluginPublishScope",
  "plugins",
  "windowsNodeTag",
  "skipParallels",
  "skipTelegram",
  "telegramProviderMode",
];

function usage() {
  return `Usage: pnpm release:candidate -- --tag vYYYY.M.PATCH-beta.N [options]

Dispatches or consumes release validation runs, validates the prepared npm tarball,
builds plugin publish plans, writes a green evidence bundle, then prints the exact
OpenClaw Release Publish command only after everything is green.

Options:
  --tag <tag>                         Release tag to validate.
  --workflow-ref <ref>                Trusted workflow ref. Default: main; matching Tideclaw branch required for alpha.
  --repo <owner/repo>                 GitHub repo. Default: ${DEFAULT_REPO}
  --full-release-run <id>             Reuse successful Full Release Validation run.
  --npm-preflight-run <id>            Reuse successful OpenClaw NPM Release preflight run.
  --windows-node-tag <tag>            Exact Windows Node release tag. Required for stable.
  --skip-dispatch                     Require both run ids; do not dispatch workflows.
  --skip-local-generated-check        Do not run local generated release baseline checks before dispatch.
  --skip-parallels                   Do not run local Parallels fresh/update candidate smoke.
  --skip-telegram                    Do not run NPM Telegram E2E against the prepared tarball.
  --telegram-provider-mode <mode>     mock-openai|live-frontier. Default: ${DEFAULT_TELEGRAM_PROVIDER_MODE}
  --provider <provider>               Full validation provider. Default: ${DEFAULT_PROVIDER}
  --mode <fresh|upgrade|both>         Full validation cross-OS mode. Default: ${DEFAULT_MODE}
  --release-profile <beta|stable|full> Default: beta for prereleases; stable otherwise.
  --npm-dist-tag <alpha|beta|latest>  Default: ${DEFAULT_NPM_DIST_TAG}
  --plugin-publish-scope <scope>      selected|all-publishable. Default: ${DEFAULT_PLUGIN_SCOPE}
  --plugins <names>                   Required when plugin scope is selected.
  --output-dir <dir>                  Evidence output dir. Default: .artifacts/release-candidate/<tag>
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function releaseBranchForTag(tag) {
  if (tag.includes("-alpha.")) {
    return "";
  }
  const version = tag.replace(/^v/u, "").split("-", 1)[0];
  return `release/${version}`;
}

/**
 * Parses release-candidate validation options and enforces publish-scope policy.
 */
export function parseArgs(argv) {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options = {
    repo: DEFAULT_REPO,
    provider: DEFAULT_PROVIDER,
    mode: DEFAULT_MODE,
    releaseProfile: "",
    npmDistTag: DEFAULT_NPM_DIST_TAG,
    pluginPublishScope: DEFAULT_PLUGIN_SCOPE,
    plugins: "",
    skipDispatch: false,
    skipLocalGeneratedCheck: false,
    skipParallels: false,
    skipTelegram: false,
    telegramProviderMode: DEFAULT_TELEGRAM_PROVIDER_MODE,
    tag: "",
    workflowRef: "",
    fullReleaseRunId: "",
    npmPreflightRunId: "",
    windowsNodeTag: "",
    windowsNodeInstallerDigests: "",
    outputDir: "",
  };
  const seen = new Set();
  const setOnce = (flag, key, value) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    options[key] = value;
  };
  parseArgv: for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break parseArgv;
      case "--tag":
        setOnce(arg, "tag", requireValue(args, ++index, arg));
        break;
      case "--workflow-ref":
        setOnce(arg, "workflowRef", requireValue(args, ++index, arg));
        break;
      case "--repo":
        setOnce(arg, "repo", requireValue(args, ++index, arg));
        break;
      case "--full-release-run":
        setOnce(arg, "fullReleaseRunId", requireValue(args, ++index, arg));
        break;
      case "--npm-preflight-run":
        setOnce(arg, "npmPreflightRunId", requireValue(args, ++index, arg));
        break;
      case "--windows-node-tag":
        setOnce(arg, "windowsNodeTag", requireValue(args, ++index, arg));
        break;
      case "--skip-dispatch":
        setOnce(arg, "skipDispatch", true);
        break;
      case "--skip-local-generated-check":
        setOnce(arg, "skipLocalGeneratedCheck", true);
        break;
      case "--skip-parallels":
        setOnce(arg, "skipParallels", true);
        break;
      case "--skip-telegram":
        setOnce(arg, "skipTelegram", true);
        break;
      case "--telegram-provider-mode":
        setOnce(arg, "telegramProviderMode", requireValue(args, ++index, arg));
        break;
      case "--provider":
        setOnce(arg, "provider", requireValue(args, ++index, arg));
        break;
      case "--mode":
        setOnce(arg, "mode", requireValue(args, ++index, arg));
        break;
      case "--release-profile":
        setOnce(arg, "releaseProfile", requireValue(args, ++index, arg));
        break;
      case "--npm-dist-tag":
        setOnce(arg, "npmDistTag", requireValue(args, ++index, arg));
        break;
      case "--plugin-publish-scope":
        setOnce(arg, "pluginPublishScope", requireValue(args, ++index, arg));
        break;
      case "--plugins":
        setOnce(arg, "plugins", requireValue(args, ++index, arg));
        break;
      case "--output-dir":
        setOnce(arg, "outputDir", requireValue(args, ++index, arg));
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.tag) {
    throw new Error("--tag is required");
  }
  if (options.tag.includes("-alpha.")) {
    if (!TIDECLAW_ALPHA_WORKFLOW_REF_PATTERN.test(options.workflowRef)) {
      throw new Error(
        "--workflow-ref must be the matching tideclaw/alpha/YYYY-MM-DD-HHMMZ branch for alpha release candidates",
      );
    }
  } else {
    options.workflowRef ||= "main";
  }
  if (!options.tag.includes("-alpha.") && options.workflowRef !== "main") {
    throw new Error("--workflow-ref must be main for regular beta and stable release candidates");
  }
  options.releaseProfile ||=
    options.tag.includes("-alpha.") || options.tag.includes("-beta.") ? "beta" : "stable";
  if (!["beta", "stable", "full"].includes(options.releaseProfile)) {
    throw new Error("--release-profile must be beta, stable, or full");
  }
  if (options.skipDispatch && (!options.fullReleaseRunId || !options.npmPreflightRunId)) {
    throw new Error("--skip-dispatch requires --full-release-run and --npm-preflight-run");
  }
  if (options.pluginPublishScope === "selected" && !options.plugins.trim()) {
    throw new Error("--plugin-publish-scope selected requires --plugins");
  }
  if (options.pluginPublishScope === "selected") {
    throw new Error(
      "--plugin-publish-scope selected is only for plugin-only repair publishes; release candidates publish OpenClaw with --plugin-publish-scope all-publishable",
    );
  }
  if (options.pluginPublishScope === "all-publishable" && options.plugins.trim()) {
    throw new Error("--plugins is only valid with --plugin-publish-scope selected");
  }
  if (options.windowsNodeTag && !WINDOWS_NODE_TAG_PATTERN.test(options.windowsNodeTag)) {
    throw new Error("--windows-node-tag must be an explicit version tag, not latest");
  }
  if (
    !options.tag.includes("-alpha.") &&
    !options.tag.includes("-beta.") &&
    !options.windowsNodeTag
  ) {
    throw new Error("stable release candidates require --windows-node-tag");
  }
  if (!["mock-openai", "live-frontier"].includes(options.telegramProviderMode)) {
    throw new Error("--telegram-provider-mode must be mock-openai or live-frontier");
  }
  return options;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: COMMAND_CAPTURE_MAX_BUFFER_BYTES,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function buildReleaseCandidateState(options, { targetSha, toolingSha }) {
  return {
    version: RELEASE_CANDIDATE_STATE_VERSION,
    phase: "validated",
    repo: options.repo,
    tag: options.tag,
    targetSha,
    toolingSha,
    workflowRef: options.workflowRef,
    provider: options.provider,
    mode: options.mode,
    releaseProfile: options.releaseProfile,
    npmDistTag: options.npmDistTag,
    pluginPublishScope: options.pluginPublishScope,
    plugins: options.plugins,
    windowsNodeTag: options.windowsNodeTag,
    skipParallels: options.skipParallels,
    skipTelegram: options.skipTelegram,
    telegramProviderMode: options.telegramProviderMode,
    fullReleaseRunId: options.fullReleaseRunId,
    npmPreflightRunId: options.npmPreflightRunId,
  };
}

export function reconcileReleaseCandidateState(saved, expected) {
  if (!saved) {
    return expected;
  }
  if (
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    saved.version !== RELEASE_CANDIDATE_STATE_VERSION
  ) {
    throw new Error("release candidate state has an unsupported schema");
  }
  for (const key of RELEASE_CANDIDATE_STATE_KEYS) {
    if (!isDeepStrictEqual(saved[key], expected[key])) {
      throw new Error(
        `release candidate state mismatch for ${key}: saved=${JSON.stringify(saved[key])} current=${JSON.stringify(expected[key])}`,
      );
    }
  }
  for (const key of ["fullReleaseRunId", "npmPreflightRunId"]) {
    if (saved[key] && expected[key] && saved[key] !== expected[key]) {
      throw new Error(`release candidate state mismatch for ${key}`);
    }
  }
  return {
    ...expected,
    phase: typeof saved.phase === "string" ? saved.phase : expected.phase,
    fullReleaseRunId: expected.fullReleaseRunId || saved.fullReleaseRunId || "",
    npmPreflightRunId: expected.npmPreflightRunId || saved.npmPreflightRunId || "",
  };
}

function writeReleaseCandidateState(path, state) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function updateReleaseCandidateState(path, state, phase, runIds = {}) {
  const next = { ...state, ...runIds, phase };
  writeReleaseCandidateState(path, next);
  return next;
}

function githubApiTimeoutMs() {
  const raw = process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_GITHUB_API_TIMEOUT_MS;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error("OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS must be a positive integer");
  }
  return value;
}

function githubApiTimedOut(error) {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Calls the GitHub REST API with the gh-auth token and a bounded timeout.
 */
export async function githubApi(path, options = {}) {
  const token = options.token ?? run("gh", ["auth", "token"], { capture: true }).trim();
  const timeoutMs = options.timeoutMs ?? githubApiTimeoutMs();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_GITHUB_API_RESPONSE_BODY_MAX_BYTES;
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = (requestToken) =>
    fetchImpl(`https://api.github.com/${path}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new DOMException("request timed out", "TimeoutError"));
      reject(new DOMException("request timed out", "TimeoutError"));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    let response = await Promise.race([request(token), timeoutPromise]);
    let text = await readBoundedResponseText(response, `GitHub API ${path}`, maxBodyBytes, {
      signal: controller.signal,
      timeoutPromise,
    });
    const primaryRateLimitExhausted =
      (response.status === 403 || response.status === 429) &&
      (/API rate limit exceeded/iu.test(text) ||
        response.headers.get("x-ratelimit-remaining") === "0");
    if (primaryRateLimitExhausted) {
      // Public release evidence remains readable without auth when one maintainer
      // token is exhausted. Mutating gh commands keep their authenticated path.
      response = await Promise.race([request(""), timeoutPromise]);
      text = await readBoundedResponseText(response, `GitHub API ${path}`, maxBodyBytes, {
        signal: controller.signal,
        timeoutPromise,
      });
    }
    if (!response.ok) {
      throw new Error(`GitHub API ${path} failed with ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  } catch (error) {
    if (githubApiTimedOut(error)) {
      throw new Error(`GitHub API ${path} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validates the immutable Windows source release contract for a stable candidate.
 */
export async function validateWindowsSourceRelease(tag, options = {}) {
  const release = await githubApi(
    `repos/${WINDOWS_NODE_REPO}/releases/tags/${encodeURIComponent(tag)}`,
    options,
  );
  if (release.tag_name !== tag) {
    throw new Error(
      `Windows source release tag mismatch: expected ${tag}, got ${release.tag_name}`,
    );
  }
  if (release.draft) {
    throw new Error(`Windows source release ${tag} must be published`);
  }
  if (release.prerelease) {
    throw new Error(`Windows source release ${tag} must not be a prerelease`);
  }

  const assets = WINDOWS_NODE_REQUIRED_ASSETS.map((name) => {
    const matches = (release.assets ?? []).filter((entry) => entry.name === name);
    if (matches.length !== 1) {
      throw new Error(
        `Windows source release ${tag} must contain exactly one required asset ${name}; found ${matches.length}`,
      );
    }
    const [asset] = matches;
    if (!SHA256_DIGEST_PATTERN.test(asset.digest ?? "")) {
      throw new Error(`Windows source release ${tag} asset ${name} is missing its SHA-256 digest`);
    }
    return { name, digest: asset.digest };
  });
  return {
    tag,
    url: release.html_url,
    assets,
  };
}

function gitRevParse(ref, cwd) {
  return run("git", ["rev-parse", ref], { capture: true, cwd }).trim();
}

function gitTopLevel(cwd) {
  return run("git", ["rev-parse", "--show-toplevel"], { capture: true, cwd }).trim();
}

function gitTrackedStatus(cwd) {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    capture: true,
    cwd,
  });
}

function fetchTrustedWorkflowSha(workflowRef, toolingRoot) {
  const remoteRef = `refs/remotes/origin/${workflowRef}`;
  run("git", ["fetch", "--no-tags", "origin", `+refs/heads/${workflowRef}:${remoteRef}`], {
    cwd: toolingRoot,
  });
  return gitRevParse(`${remoteRef}^{commit}`, toolingRoot);
}

function runFromTrustedTooling(argv, { targetRoot, workflowRef }) {
  const trustedToolingSha = fetchTrustedWorkflowSha(workflowRef, targetRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-tooling-"));
  const toolingRoot = join(tempRoot, "checkout");
  let worktreeAdded = false;
  try {
    run("git", ["worktree", "add", "--detach", toolingRoot, trustedToolingSha], {
      cwd: targetRoot,
    });
    worktreeAdded = true;
    const result = spawnSync(
      process.execPath,
      [join(toolingRoot, "scripts/release-candidate-checklist.mjs"), ...argv],
      {
        cwd: targetRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `trusted release candidate tooling failed with ${result.status ?? result.signal}`,
      );
    }
  } finally {
    if (worktreeAdded) {
      const cleanup = spawnSync("git", ["worktree", "remove", "--force", toolingRoot], {
        cwd: targetRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (cleanup.status !== 0) {
        console.warn(
          `could not remove temporary trusted tooling worktree: ${cleanup.stderr?.trim() || cleanup.signal || cleanup.status}`,
        );
      }
    }
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

export function validateCandidateCheckout({
  targetSha,
  targetHeadSha,
  targetTrackedStatus,
  toolingSha,
  trustedToolingSha,
  toolingTrackedStatus,
  workflowRef,
}) {
  if (targetHeadSha !== targetSha) {
    throw new Error(
      `release candidate tag resolves to ${targetSha}, but target worktree HEAD is ${targetHeadSha}`,
    );
  }
  if (targetTrackedStatus.trim()) {
    throw new Error(
      "release candidate validation requires a clean tracked target worktree at the release tag",
    );
  }
  if (toolingSha !== trustedToolingSha) {
    throw new Error(
      `release candidate tooling HEAD ${toolingSha} does not match trusted ${workflowRef} ${trustedToolingSha}`,
    );
  }
  if (toolingTrackedStatus.trim()) {
    throw new Error(
      "release candidate validation requires a clean tracked tooling checkout at the trusted workflow ref",
    );
  }
  return { status: "passed", targetSha, toolingSha, workflowRef };
}

function gitIsAncestor(ancestor, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${ancestor}^{commit}`, `${target}^{commit}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(
    `could not validate changelog provenance ${ancestor}..${target}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

export function validateNpmPreflightRunSource({
  workflowRun,
  workflowRef,
  isTrustedWorkflowAncestor = gitIsAncestor,
}) {
  const trustedRef = `refs/remotes/origin/${workflowRef}`;
  if (!isTrustedWorkflowAncestor(workflowRun.headSha, trustedRef)) {
    throw new Error(
      `npm preflight workflow SHA ${workflowRun.headSha} is not reachable from trusted ${workflowRef}`,
    );
  }
  return {
    status: "passed",
    headSha: workflowRun.headSha,
    workflowRef,
  };
}

function candidateContributionRecordPullRequests(
  section,
  label,
  { requireExactProvenance = true } = {},
) {
  const recordStart = section.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    throw new Error(`${label} is missing ### Complete contribution record`);
  }
  const record = section.slice(recordStart);
  const rowNumbers = [...record.matchAll(/^- \*\*PR #(?<number>[0-9]+)\*\*/gmu)].map((match) =>
    Number(match.groups.number),
  );
  const rows = new Set(rowNumbers);
  if (rows.size !== rowNumbers.length) {
    const seen = new Set();
    const duplicates = rowNumbers.filter((number) => {
      if (seen.has(number)) {
        return true;
      }
      seen.add(number);
      return false;
    });
    throw new Error(
      `${label} contains duplicate contribution record PR rows: ${[...new Set(duplicates)]
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  if (!requireExactProvenance) {
    return rows;
  }
  const provenance = record.match(
    /^This audited record covers the complete \S+\.\.[0-9a-f]{40} history: (?<count>[0-9]+) merged PRs?\./mu,
  );
  if (!provenance?.groups?.count) {
    throw new Error(`${label} is missing exact complete contribution record provenance`);
  }
  const declaredCount = Number(provenance.groups.count);
  if (rows.size !== declaredCount) {
    throw new Error(
      `${label} contribution record declares ${declaredCount} PRs but contains ${rows.size}`,
    );
  }
  return rows;
}

export function candidateCumulativeShippedPullRequests(changelog, label) {
  const pullRequests = new Set();
  for (const section of extractChangelogReleaseSections(changelog)) {
    if (
      section.version === "Unreleased" ||
      !section.source.includes("\n### Complete contribution record")
    ) {
      continue;
    }
    for (const number of candidateContributionRecordPullRequests(
      section.source,
      `${label} section ${section.version}`,
      { requireExactProvenance: false },
    )) {
      pullRequests.add(number);
    }
  }
  return pullRequests;
}

function loadCandidateShippedBaseline(ref) {
  const tagRef = `refs/tags/${ref}`;
  gitRevParse(`${tagRef}^{commit}`);
  const changelog = run("git", ["show", `${tagRef}:CHANGELOG.md`], { capture: true });
  const version = releaseNotesVersionForTag(ref);
  candidateContributionRecordPullRequests(
    extractChangelogSection(changelog, version),
    `shipped baseline ${ref}`,
  );
  const pullRequests = candidateCumulativeShippedPullRequests(changelog, `shipped baseline ${ref}`);
  return { ref, pullRequests };
}

export function validateCandidateReleaseNotes({ changelog, repository, tag }) {
  const rendered = renderGithubReleaseNotes({
    changelog,
    version: releaseNotesVersionForTag(tag),
    tag,
    repository,
  });
  return {
    status: "passed",
    mode: rendered.mode,
    characters: rendered.size.characters,
    bytes: rendered.size.bytes,
  };
}

export function validateCandidateChangelogProvenance({
  changelog,
  version,
  tag,
  targetSha,
  isAncestor = gitIsAncestor,
  loadShippedBaseline = loadCandidateShippedBaseline,
}) {
  // Validate the same section the renderer publishes: alpha and correction
  // tags may carry their own heading, and alpha tags may fall back to
  // Unreleased.
  let section;
  let sectionVersion = version;
  let usesAlphaUnreleasedFallback = false;
  const dedicatedVersion = dedicatedSectionVersionForTag(tag);
  if (dedicatedVersion && dedicatedVersion !== version) {
    try {
      section = extractChangelogSection(changelog, dedicatedVersion);
      sectionVersion = dedicatedVersion;
    } catch {
      // No dedicated section; validate the base section.
    }
  }
  if (section === undefined) {
    try {
      section = extractChangelogSection(changelog, version);
    } catch (error) {
      if (!/-alpha\.[1-9][0-9]*$/u.test(tag)) {
        throw error;
      }
      section = releaseNotesSectionForTag(changelog, version, tag);
      usesAlphaUnreleasedFallback = true;
    }
  }
  const recordStart = section.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    if (usesAlphaUnreleasedFallback) {
      return {
        status: "skipped",
        reason: "alpha release uses the explicit Unreleased fallback",
        shippedBaselines: [],
      };
    }
    throw new Error(
      `CHANGELOG.md ## ${sectionVersion} is missing ### Complete contribution record`,
    );
  }
  const record = section.slice(recordStart);
  const recordedPullRequests = candidateContributionRecordPullRequests(
    section,
    `CHANGELOG.md ## ${sectionVersion}`,
  );
  const provenance = record.match(
    /^This audited record covers the complete (?<base>\S+)\.\.(?<target>[0-9a-f]{40}) history:/mu,
  );
  const base = provenance?.groups?.base;
  const recordedTarget = provenance?.groups?.target;
  if (!base || !recordedTarget) {
    throw new Error(
      `CHANGELOG.md ## ${sectionVersion} is missing exact complete contribution record provenance`,
    );
  }
  const shippedBaselines = parseShippedBaselineExclusions(record);
  const sectionShippedBaselines = parseShippedBaselineExclusions(section);
  if (
    formatShippedBaselineExclusions(sectionShippedBaselines) !==
    formatShippedBaselineExclusions(shippedBaselines)
  ) {
    throw new Error(
      "shipped baseline exclusions must appear inside the complete contribution record",
    );
  }
  if (!isAncestor(base, recordedTarget)) {
    throw new Error(
      `CHANGELOG.md contribution record base ${base} is not an ancestor of recorded target ${recordedTarget}`,
    );
  }
  // The record is generated before its own changelog/finalization commit. Require
  // reachability so the tag can contain that bounded release-only follow-up.
  if (!isAncestor(recordedTarget, targetSha)) {
    throw new Error(
      `CHANGELOG.md contribution record target ${recordedTarget} is not reachable from release tag ${targetSha}`,
    );
  }
  // The verifier persists associated and text-linked PR exclusions together.
  // Revalidate that exact inventory here instead of rediscovering a narrower set from git text.
  const excludedPullRequests = new Set();
  for (const baseline of shippedBaselines) {
    const loaded = loadShippedBaseline(baseline.ref);
    if (!(loaded.pullRequests instanceof Set)) {
      throw new Error(`shipped baseline ${baseline.ref} did not provide a PR inventory`);
    }
    const duplicateExclusions = baseline.pullRequests.filter((number) =>
      excludedPullRequests.has(number),
    );
    if (duplicateExclusions.length > 0) {
      throw new Error(
        `release contribution record repeats shipped PR exclusions across baselines: ${duplicateExclusions.map((number) => `#${number}`).join(", ")}`,
      );
    }
    const absent = baseline.pullRequests.filter((number) => !loaded.pullRequests.has(number));
    if (absent.length > 0) {
      throw new Error(
        `release contribution record lists PRs absent from shipped baseline ${baseline.ref}: ${absent.map((number) => `#${number}`).join(", ")}`,
      );
    }
    const retained = [...recordedPullRequests].filter((number) => loaded.pullRequests.has(number));
    if (retained.length > 0) {
      throw new Error(
        `release contribution record still contains shipped PRs from ${baseline.ref}: ${retained.map((number) => `#${number}`).join(", ")}`,
      );
    }
    for (const number of baseline.pullRequests) {
      excludedPullRequests.add(number);
    }
  }
  return { status: "passed", base, target: recordedTarget, shippedBaselines };
}

async function runArtifacts(repo, runId) {
  const data = await githubApi(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  return (data.artifacts ?? []).map((artifact) => ({
    digest: artifact.digest,
    expired: artifact.expired,
    id: artifact.id,
    name: artifact.name,
    workflowRunId: artifact.workflow_run?.id,
  }));
}

/**
 * Chooses the expected artifact name, allowing one same-prefix fallback per run.
 */
export function resolveArtifactName(artifacts, preferredName, prefix) {
  const available = artifacts
    .filter((artifact) => artifact.expired !== true)
    .map((artifact) => artifact.name);
  if (available.includes(preferredName)) {
    return preferredName;
  }
  const candidates = available.filter((name) => name.startsWith(prefix));
  if (candidates.length === 1) {
    console.warn(`artifact ${preferredName} not found; using ${candidates[0]} from the same run`);
    return candidates[0];
  }
  const candidateList =
    available.length > 0 ? available.map((name) => `- ${name}`).join("\n") : "- <none>";
  throw new Error(
    `artifact ${preferredName} not found in run. Expected ${preferredName} or exactly one ${prefix}* fallback.\nAvailable artifacts:\n${candidateList}`,
  );
}

async function resolveRunArtifact(repo, runId, preferredName, prefix) {
  const artifacts = await runArtifacts(repo, runId);
  const name = resolveArtifactName(artifacts, preferredName, prefix);
  const artifact = artifacts.find((candidate) => candidate.name === name);
  if (!artifact) {
    throw new Error(`resolved artifact ${name} disappeared from run ${runId}`);
  }
  return artifact;
}

function runAndEcho(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}\n${
        result.stderr ?? ""
      }`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runLocalGeneratedCheckIfNeeded(options) {
  if (options.skipLocalGeneratedCheck) {
    return { status: "skipped", reason: "operator skipped --skip-local-generated-check" };
  }
  run("pnpm", ["release:generated:check"]);
  return { status: "passed", command: "pnpm release:generated:check" };
}

/**
 * Extracts a GitHub Actions run id from gh workflow dispatch output.
 */
export function parseRunIdFromDispatchOutput(output) {
  return output.match(/actions\/runs\/([0-9]+)/u)?.[1] ?? "";
}

export function requireRunIdFromDispatchOutput(output, workflowFile) {
  const runId = parseRunIdFromDispatchOutput(output);
  if (!runId) {
    throw new Error(
      `gh workflow run ${workflowFile} did not return an Actions run URL; refusing to guess from recent workflow_dispatch runs`,
    );
  }
  return runId;
}

async function wait(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dispatchWorkflow(repo, workflowFile, workflowRef, fields) {
  const args = ["workflow", "run", workflowFile, "--repo", repo, "--ref", workflowRef];
  for (const [key, value] of Object.entries(fields)) {
    args.push("-f", `${key}=${String(value)}`);
  }
  return requireRunIdFromDispatchOutput(runAndEcho("gh", args), workflowFile);
}

async function runInfo(repo, runId) {
  const [runData, jobsData] = await Promise.all([
    githubApi(`repos/${repo}/actions/runs/${runId}`),
    githubApi(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`),
  ]);
  return {
    databaseId: runData.id,
    runAttempt: runData.run_attempt,
    workflowName: runData.name,
    workflowPath: runData.path,
    repository: runData.repository?.full_name,
    headBranch: runData.head_branch,
    headSha: runData.head_sha,
    event: runData.event,
    status: runData.status,
    conclusion: runData.conclusion,
    url: runData.html_url,
    jobs: (jobsData.jobs ?? []).map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.html_url,
    })),
  };
}

async function pendingDeployments(repo, runId) {
  try {
    return await githubApi(`repos/${repo}/actions/runs/${runId}/pending_deployments`);
  } catch {
    return [];
  }
}

function summarizePendingDeployments(repo, runId, deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return "";
  }
  return deployments
    .map((deployment) => {
      const environment = deployment.environment ?? {};
      return [
        `- pending approval: env=${environment.name ?? "<unknown>"} canApprove=${String(deployment.current_user_can_approve ?? "<unknown>")}`,
        `  approve: gh api -X POST repos/${repo}/actions/runs/${runId}/pending_deployments -F 'environment_ids[]=${environment.id ?? "<id>"}' -f state=approved -f comment='Approve release gate'`,
      ].join("\n");
    })
    .join("\n");
}

function summarizeFailedRun(info) {
  const failedJobs = (info.jobs ?? []).filter(
    (job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped",
  );
  return [
    `${info.workflowName} ${info.databaseId} ended ${info.status}/${info.conclusion}: ${info.url}`,
    ...failedJobs.map((job) => `- ${job.name}: ${job.conclusion} ${job.url ?? ""}`),
  ].join("\n");
}

async function waitForSuccessfulRun(repo, runId, expected) {
  let lastState = "";
  for (;;) {
    const info = await runInfo(repo, runId);
    const state = `${info.status}:${info.conclusion ?? ""}`;
    if (state !== lastState) {
      console.log(
        `${info.workflowName} ${runId}: ${info.status}${info.conclusion ? `/${info.conclusion}` : ""} ${info.url}`,
      );
      const pending = summarizePendingDeployments(
        repo,
        runId,
        await pendingDeployments(repo, runId),
      );
      if (pending) {
        console.log(pending);
      }
      lastState = state;
    }
    if (info.status === "completed") {
      if (info.conclusion !== "success") {
        throw new Error(summarizeFailedRun(info));
      }
      if (info.workflowName !== expected.workflowName) {
        throw new Error(
          `run ${runId} workflow mismatch: expected ${expected.workflowName}, got ${info.workflowName}`,
        );
      }
      const acceptsPinnedWorkflow =
        expected.allowShaPinnedWorkflowRef && isShaPinnedReleaseValidationBranch(info.headBranch);
      if (info.headBranch !== expected.workflowRef && !acceptsPinnedWorkflow) {
        throw new Error(
          `run ${runId} branch mismatch: expected ${expected.workflowRef}, got ${info.headBranch}`,
        );
      }
      return info;
    }
    await wait(30_000);
  }
}

function downloadArtifact(repo, runId, name, dir) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  run("gh", ["run", "download", runId, "--repo", repo, "--name", name, "--dir", dir]);
}

async function downloadResolvedArtifact(repo, runId, preferredName, prefix, dir) {
  const artifact = await resolveRunArtifact(repo, runId, preferredName, prefix);
  downloadArtifact(repo, runId, artifact.name, dir);
  return artifact;
}

function sha256(path) {
  return run("shasum", ["-a", "256", path], { capture: true }).trim().split(/\s+/u)[0] ?? "";
}

function pluginPlanArgs(options) {
  const args = ["--selection-mode", options.pluginPublishScope];
  if (options.pluginPublishScope === "selected") {
    args.push("--plugins", options.plugins);
  }
  return args;
}

function collectPluginPlan(script, options) {
  return JSON.parse(
    run("node", ["--import", "tsx", script, ...pluginPlanArgs(options)], { capture: true }),
  );
}

async function collectPluginPlanWithRetry(script, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return collectPluginPlan(script, options);
    } catch (error) {
      lastError = error;
      if (attempt === 3) {
        break;
      }
      console.warn(
        `${script} failed on attempt ${attempt}; retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await wait(5_000 * attempt);
    }
  }
  throw lastError;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

/**
 * Builds the final release publish workflow command once validation evidence is ready.
 */
export function buildPublishCommand(options) {
  const workflowRef = options.tag.includes("-alpha.") ? options.workflowRef : "main";
  if (options.tag.includes("-alpha.") && !TIDECLAW_ALPHA_WORKFLOW_REF_PATTERN.test(workflowRef)) {
    throw new Error(
      "alpha release publish requires a matching tideclaw/alpha/YYYY-MM-DD-HHMMZ workflow ref",
    );
  }
  const fields = [
    ["tag", options.tag],
    ["preflight_run_id", options.npmPreflightRunId],
    ["full_release_validation_run_id", options.fullReleaseRunId],
    ["full_release_validation_run_attempt", options.fullReleaseRunAttempt],
    ["npm_dist_tag", options.npmDistTag],
    ["plugin_publish_scope", options.pluginPublishScope],
    ["publish_openclaw_npm", "true"],
    ["release_profile", "from-validation"],
    ["wait_for_clawhub", "false"],
  ];
  if (options.npmTelegramRunId) {
    fields.push(["npm_telegram_run_id", options.npmTelegramRunId]);
  }
  if (options.windowsNodeTag) {
    fields.push(["windows_node_tag", options.windowsNodeTag]);
  }
  if (options.windowsNodeInstallerDigests) {
    fields.push(["windows_node_installer_digests", options.windowsNodeInstallerDigests]);
  }
  if (options.plugins.trim()) {
    fields.push(["plugins", options.plugins]);
  }
  return [
    "gh",
    "workflow",
    "run",
    "openclaw-release-publish.yml",
    "--repo",
    options.repo,
    "--ref",
    workflowRef,
    ...fields.flatMap(([key, value]) => ["-f", `${key}=${value}`]),
  ]
    .map(shellQuote)
    .join(" ");
}

export function validatePreflightManifest(manifest, params) {
  if (manifest.releaseTag !== params.tag) {
    throw new Error(
      `npm preflight tag mismatch: expected ${params.tag}, got ${manifest.releaseTag}`,
    );
  }
  if (manifest.releaseSha !== params.targetSha) {
    throw new Error(
      `npm preflight SHA mismatch: expected ${params.targetSha}, got ${manifest.releaseSha}`,
    );
  }
  if (manifest.npmDistTag !== params.npmDistTag) {
    throw new Error(
      `npm preflight dist-tag mismatch: expected ${params.npmDistTag}, got ${manifest.npmDistTag}`,
    );
  }
  if (!manifest.tarballName || !manifest.tarballSha256) {
    throw new Error("npm preflight manifest missing tarball metadata");
  }
  if (!Array.isArray(manifest.dependencyTarballs)) {
    throw new Error("npm preflight manifest missing dependency tarball metadata");
  }
  for (const dependency of manifest.dependencyTarballs) {
    if (
      !dependency?.packageName ||
      !dependency.packageVersion ||
      !dependency.tarballName ||
      !dependency.tarballSha256 ||
      dependency.tarballName !== basename(dependency.tarballName)
    ) {
      throw new Error("npm preflight manifest contains invalid dependency tarball metadata");
    }
  }
}

export function validateFullManifest(manifest, params) {
  if (manifest.workflowName !== "Full Release Validation") {
    throw new Error(`full validation workflow mismatch: ${manifest.workflowName}`);
  }
  if (manifest.targetSha !== params.targetSha) {
    throw new Error(
      `full validation SHA mismatch: expected ${params.targetSha}, got ${manifest.targetSha}`,
    );
  }
  if (manifest.releaseProfile !== params.releaseProfile) {
    throw new Error(
      `full validation profile mismatch: expected ${params.releaseProfile}, got ${manifest.releaseProfile}`,
    );
  }
  if (manifest.rerunGroup !== "all") {
    throw new Error(`full validation must use rerun_group=all, got ${manifest.rerunGroup}`);
  }
  if (
    (params.releaseProfile === "stable" || params.releaseProfile === "full") &&
    manifest.runReleaseSoak !== "true"
  ) {
    throw new Error(
      `full validation must record runReleaseSoak=true for ${params.releaseProfile} release candidates`,
    );
  }
  if (manifest.controls?.performanceBlocking !== true) {
    throw new Error("full validation manifest must record blocking product performance evidence");
  }
}

export function candidateParallelsArgs(
  tarballPath,
  dependencyTarballPaths = [],
  toolingRoot = TOOLING_ROOT,
) {
  return [
    "exec",
    "tsx",
    join(toolingRoot, "scripts/e2e/parallels/npm-update-smoke.ts"),
    "--target-tarball",
    tarballPath,
    ...dependencyTarballPaths.flatMap((dependency) => ["--dependency-tarball", dependency]),
    "--json",
  ];
}

export function candidateParallelsShellCommand(
  tarballPath,
  timeoutBin,
  dependencyTarballPaths = [],
) {
  // Login shells can replace the candidate's supported Node with ambient host Node.
  // Keep the invoking Node first so pnpm and npm use the validated runtime.
  const nodeBinDir = dirname(process.execPath);
  return [
    'set -a; source "$HOME/.profile" >/dev/null 2>&1 || true; set +a;',
    `export PATH=${shellQuote(nodeBinDir)}:"$PATH";`,
    "exec",
    shellQuote(timeoutBin),
    "--foreground",
    "150m",
    "pnpm",
    ...candidateParallelsArgs(tarballPath, dependencyTarballPaths).map(shellQuote),
  ].join(" ");
}

async function runParallelsIfNeeded(options, tarballPath, dependencyTarballPaths) {
  if (options.skipParallels) {
    return { status: "skipped", reason: "operator skipped --skip-parallels" };
  }
  // This function runs inside trusted tooling, not the frozen target checkout.
  // Prepare its isolated dependencies here before importing the Parallels harness.
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"], {
    cwd: TOOLING_ROOT,
  });
  const timeoutBin = run("bash", ["-lc", "command -v gtimeout || command -v timeout"], {
    capture: true,
  }).trim();
  const command = candidateParallelsShellCommand(tarballPath, timeoutBin, dependencyTarballPaths);
  run("bash", ["-lc", command], {
    env: {
      OPENCLAW_PARALLELS_ARTIFACT_ROOT: join(process.cwd(), ".artifacts", "parallels"),
    },
  });
  return {
    status: "passed",
    command,
  };
}

export function buildTelegramArtifactInputs({ artifact, manifest, runAttempt, runId, sourceSha }) {
  const artifactDigest = artifact.digest?.match(/^sha256:([0-9a-f]{64})$/u)?.[1];
  if (!Number.isInteger(artifact.id) || artifact.id < 1 || !artifactDigest) {
    throw new Error(`npm preflight artifact ${artifact.name} is missing immutable identity`);
  }
  if (String(artifact.workflowRunId) !== String(runId)) {
    throw new Error(
      `npm preflight artifact ${artifact.name} belongs to run ${artifact.workflowRunId}, not ${runId}`,
    );
  }
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error(`npm preflight run ${runId} has invalid attempt`);
  }
  return {
    package_artifact_digest: artifactDigest,
    package_artifact_id: artifact.id,
    package_artifact_name: artifact.name,
    package_artifact_run_attempt: runAttempt,
    package_artifact_run_id: runId,
    package_file_name: manifest.tarballName,
    package_sha256: manifest.tarballSha256,
    package_source_sha: sourceSha,
    package_version: manifest.packageVersion,
  };
}

async function runTelegramIfNeeded(options, artifact, manifest, runAttempt, sourceSha) {
  if (options.skipTelegram) {
    return { status: "skipped" };
  }
  const workflowFile = "npm-telegram-beta-e2e.yml";
  const artifactInputs = buildTelegramArtifactInputs({
    artifact,
    manifest,
    runAttempt,
    runId: options.npmPreflightRunId,
    sourceSha,
  });
  const runId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
    package_spec: `openclaw@${options.tag.replace(/^v/u, "")}`,
    package_label: options.tag,
    ...artifactInputs,
    harness_ref: options.workflowRef,
    provider_mode: options.telegramProviderMode,
  });
  const runLocal = await waitForSuccessfulRun(options.repo, runId, {
    workflowName: "NPM Telegram Beta E2E",
    workflowRef: options.workflowRef,
  });
  return {
    status: "passed",
    runId,
    url: runLocal.url,
    artifactName: artifact.name,
    providerMode: options.telegramProviderMode,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetRoot = gitTopLevel(process.cwd());
  const toolingRoot = gitTopLevel(TOOLING_ROOT);
  if (targetRoot === toolingRoot) {
    runFromTrustedTooling(process.argv.slice(2), {
      targetRoot,
      workflowRef: options.workflowRef,
    });
    return;
  }
  options.outputDir ||= join(".artifacts", "release-candidate", options.tag);
  const targetSha = gitRevParse(`${options.tag}^{}`, targetRoot);
  const toolingSha = gitRevParse("HEAD", TOOLING_ROOT);
  const trustedToolingSha = fetchTrustedWorkflowSha(options.workflowRef, TOOLING_ROOT);
  validateCandidateCheckout({
    targetSha,
    targetHeadSha: gitRevParse("HEAD", targetRoot),
    targetTrackedStatus: gitTrackedStatus(targetRoot),
    toolingSha,
    trustedToolingSha,
    toolingTrackedStatus: gitTrackedStatus(TOOLING_ROOT),
    workflowRef: options.workflowRef,
  });
  const statePath = join(options.outputDir, RELEASE_CANDIDATE_STATE_FILE);
  const expectedState = buildReleaseCandidateState(options, { targetSha, toolingSha });
  let candidateState = reconcileReleaseCandidateState(
    existsSync(statePath) ? readJson(statePath, "release candidate state") : undefined,
    expectedState,
  );
  options.fullReleaseRunId = candidateState.fullReleaseRunId;
  options.npmPreflightRunId = candidateState.npmPreflightRunId;
  writeReleaseCandidateState(statePath, candidateState);
  const releaseChangelog = run("git", ["show", `${targetSha}:CHANGELOG.md`], { capture: true });
  const releaseNotesVersion = releaseNotesVersionForTag(options.tag);
  const releaseNotesCheck = validateCandidateReleaseNotes({
    changelog: releaseChangelog,
    repository: options.repo,
    tag: options.tag,
  });
  const releaseNotesProvenance = validateCandidateChangelogProvenance({
    changelog: releaseChangelog,
    version: releaseNotesVersion,
    tag: options.tag,
    targetSha,
  });
  const windowsNodeSourceRelease = options.windowsNodeTag
    ? await validateWindowsSourceRelease(options.windowsNodeTag)
    : undefined;
  options.windowsNodeInstallerDigests = windowsNodeSourceRelease
    ? JSON.stringify(
        Object.fromEntries(
          windowsNodeSourceRelease.assets.map((asset) => [asset.name, asset.digest]),
        ),
      )
    : "";
  const localGeneratedCheck = runLocalGeneratedCheckIfNeeded(options);

  if (!options.fullReleaseRunId && !options.skipDispatch) {
    const workflowFile = "full-release-validation.yml";
    const targetContextRef = releaseBranchForTag(options.tag);
    options.fullReleaseRunId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
      ref: options.tag,
      ...(targetContextRef ? { target_context_ref: targetContextRef } : {}),
      provider: options.provider,
      mode: options.mode,
      release_profile: options.releaseProfile,
      run_release_soak:
        options.releaseProfile === "stable" || options.releaseProfile === "full" ? "true" : "false",
      rerun_group: "all",
    });
    candidateState = updateReleaseCandidateState(statePath, candidateState, "dispatching", {
      fullReleaseRunId: options.fullReleaseRunId,
    });
  }

  if (!options.npmPreflightRunId && !options.skipDispatch) {
    const workflowFile = "openclaw-npm-release.yml";
    options.npmPreflightRunId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
      tag: options.tag,
      preflight_only: "true",
      npm_dist_tag: options.npmDistTag,
    });
    candidateState = updateReleaseCandidateState(statePath, candidateState, "dispatching", {
      npmPreflightRunId: options.npmPreflightRunId,
    });
  }
  candidateState = updateReleaseCandidateState(statePath, candidateState, "waiting", {
    fullReleaseRunId: options.fullReleaseRunId,
    npmPreflightRunId: options.npmPreflightRunId,
  });

  const fullRun = await waitForSuccessfulRun(options.repo, options.fullReleaseRunId, {
    workflowName: "Full Release Validation",
    workflowRef: options.workflowRef,
    allowShaPinnedWorkflowRef: true,
  });
  const npmRun = await waitForSuccessfulRun(options.repo, options.npmPreflightRunId, {
    workflowName: "OpenClaw NPM Release",
    workflowRef: options.workflowRef,
  });
  const npmPreflightSource = validateNpmPreflightRunSource({
    workflowRun: npmRun,
    workflowRef: options.workflowRef,
  });

  const npmDir = join(options.outputDir, "npm-preflight");
  const fullDir = join(options.outputDir, "full-release-validation");
  const npmArtifact = await downloadResolvedArtifact(
    options.repo,
    options.npmPreflightRunId,
    `openclaw-npm-preflight-${options.tag}`,
    "openclaw-npm-preflight-",
    npmDir,
  );
  const npmArtifactName = npmArtifact.name;
  if (!Number.isInteger(fullRun.runAttempt) || fullRun.runAttempt < 1) {
    throw new Error(`Full Release Validation run ${options.fullReleaseRunId} has invalid attempt.`);
  }
  const fullArtifactName = `full-release-validation-${options.fullReleaseRunId}-${fullRun.runAttempt}`;
  downloadArtifact(options.repo, options.fullReleaseRunId, fullArtifactName, fullDir);

  const npmManifest = readJson(join(npmDir, "preflight-manifest.json"), "npm preflight manifest");
  const fullManifest = readJson(
    join(fullDir, "full-release-validation-manifest.json"),
    "full validation manifest",
  );
  run("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
    capture: true,
  });
  const fullValidationEvidence = validateFullReleaseValidationEvidence({
    run: fullRun,
    manifest: fullManifest,
    expectedRepository: options.repo,
    expectedRunId: options.fullReleaseRunId,
    expectedTargetSha: targetSha,
    expectedWorkflowBranch: options.workflowRef,
    isTrustedMainAncestor: (sha) => gitIsAncestor(sha, "refs/remotes/origin/main"),
    validateEvidenceReuseStrictly: ({ repository, runId }) =>
      runStrictReleaseEvidenceValidation({ repository, runId }),
  });
  if (fullValidationEvidence.source === "direct" && fullRun.headSha !== targetSha) {
    throw new Error(`run SHA mismatch: tag=${targetSha} full=${fullRun.headSha}`);
  }
  validatePreflightManifest(npmManifest, {
    tag: options.tag,
    targetSha,
    npmDistTag: options.npmDistTag,
  });
  validateFullManifest(fullManifest, {
    targetSha,
    releaseProfile: options.releaseProfile,
  });
  const tarballPath = join(npmDir, npmManifest.tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`prepared tarball missing: ${tarballPath}`);
  }
  const actualTarballSha = sha256(tarballPath);
  if (actualTarballSha !== npmManifest.tarballSha256) {
    throw new Error(
      `prepared tarball digest mismatch: expected ${npmManifest.tarballSha256}, got ${actualTarballSha}`,
    );
  }
  const dependencyTarballPaths = npmManifest.dependencyTarballs.map((dependency) => {
    const dependencyPath = join(npmDir, dependency.tarballName);
    if (!existsSync(dependencyPath)) {
      throw new Error(`prepared dependency tarball missing: ${dependencyPath}`);
    }
    const actualDependencySha = sha256(dependencyPath);
    if (actualDependencySha !== dependency.tarballSha256) {
      throw new Error(
        `prepared dependency tarball digest mismatch for ${dependency.packageName}: expected ${dependency.tarballSha256}, got ${actualDependencySha}`,
      );
    }
    return dependencyPath;
  });

  const parallels = await runParallelsIfNeeded(options, tarballPath, dependencyTarballPaths);
  const npmTelegram = await runTelegramIfNeeded(
    options,
    npmArtifact,
    npmManifest,
    npmRun.runAttempt,
    targetSha,
  );
  options.npmTelegramRunId = npmTelegram.runId ?? "";
  const pluginNpmPlan = await collectPluginPlanWithRetry(
    "scripts/plugin-npm-release-plan.ts",
    options,
  );
  const pluginClawHubPlan = await collectPluginPlanWithRetry(
    "scripts/plugin-clawhub-release-plan.ts",
    options,
  );
  const publishCommand = buildPublishCommand({
    ...options,
    fullReleaseRunAttempt: fullRun.runAttempt,
  });
  const evidence = {
    version: 1,
    tag: options.tag,
    targetSha,
    workflowRef: options.workflowRef,
    npmDistTag: options.npmDistTag,
    fullReleaseValidationRunId: options.fullReleaseRunId,
    fullReleaseValidationRunAttempt: fullRun.runAttempt,
    npmPreflightRunId: options.npmPreflightRunId,
    windowsNodeTag: options.windowsNodeTag || undefined,
    windowsNodeSourceRelease,
    fullReleaseValidationUrl: fullRun.url,
    fullReleaseValidationControls: fullManifest.controls,
    npmPreflightUrl: npmRun.url,
    npmPreflightSource,
    artifacts: {
      npmPreflight: npmArtifactName,
      fullReleaseValidation: fullArtifactName,
    },
    releaseNotesCheck,
    releaseNotesProvenance,
    localGeneratedCheck,
    tarball: {
      name: basename(tarballPath),
      sha256: actualTarballSha,
      path: tarballPath,
    },
    parallels,
    npmTelegram,
    pluginNpmPlan,
    pluginClawHubPlan,
    publishCommand,
  };
  mkdirSync(options.outputDir, { recursive: true });
  const evidencePath = join(options.outputDir, "release-candidate-evidence.json");
  const evidenceMarkdownPath = join(options.outputDir, "release-candidate-evidence.md");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(
    evidenceMarkdownPath,
    [
      `# ${options.tag} release candidate evidence`,
      "",
      `- target SHA: ${targetSha}`,
      `- full release validation: ${options.fullReleaseRunId} ${fullRun.url}`,
      `- npm preflight: ${options.npmPreflightRunId} ${npmRun.url}`,
      ...(windowsNodeSourceRelease
        ? [
            `- Windows Node source release: ${windowsNodeSourceRelease.tag} ${windowsNodeSourceRelease.url}`,
            ...windowsNodeSourceRelease.assets.map(
              (asset) => `- Windows Node source asset: ${asset.name} ${asset.digest}`,
            ),
          ]
        : []),
      `- npm preflight artifact: ${npmArtifactName}`,
      `- full release artifact: ${fullArtifactName}`,
      `- GitHub release notes: ${releaseNotesCheck.status} (${releaseNotesCheck.mode}, ${releaseNotesCheck.characters} characters, ${releaseNotesCheck.bytes} bytes)`,
      releaseNotesProvenance.status === "passed"
        ? `- changelog provenance: passed (${releaseNotesProvenance.base}..${releaseNotesProvenance.target})`
        : `- changelog provenance: skipped (${releaseNotesProvenance.reason})`,
      `- ${
        formatShippedBaselineExclusions(releaseNotesProvenance.shippedBaselines) ||
        "Shipped baseline exclusions: none"
      }`,
      `- local generated release checks: ${localGeneratedCheck.status}${
        localGeneratedCheck.reason ? ` (${localGeneratedCheck.reason})` : ""
      }`,
      `- tarball: ${basename(tarballPath)}`,
      `- tarball sha256: ${actualTarballSha}`,
      `- npm dist-tag: ${options.npmDistTag}`,
      `- plugin npm plan: ${pluginNpmPlan.packages?.length ?? 0} packages`,
      `- ClawHub plan: ${pluginClawHubPlan.packages?.length ?? 0} packages`,
      `- Parallels: ${parallels.status}${parallels.reason ? ` (${parallels.reason})` : ""}`,
      `- NPM Telegram E2E: ${npmTelegram.status}${
        npmTelegram.runId ? ` ${npmTelegram.runId} ${npmTelegram.url}` : ""
      }`,
      "",
      "Publish command:",
      "",
      "```bash",
      publishCommand,
      "```",
      "",
    ].join("\n"),
  );
  updateReleaseCandidateState(statePath, candidateState, "completed");

  console.log(`release candidate evidence: ${evidencePath}`);
  console.log(`release candidate summary: ${evidenceMarkdownPath}`);
  console.log("publish command:");
  console.log(publishCommand);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

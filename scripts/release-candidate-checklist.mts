#!/usr/bin/env node
// Coordinates release-candidate validation runs and emits the publish command
// only after required local, CI, npm, plugin, and E2E evidence is green.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml } from "yaml";
import {
  booleanFlag,
  parseFlagArgs,
  stringFlag,
  stringListFlag,
  stripLeadingPackageManagerSeparator,
} from "./lib/arg-utils.mts";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { validatePluginSdkApiReleaseEvidence } from "./plugin-sdk-api-release-evidence.mjs";
import {
  dedicatedSectionVersionForTag,
  extractChangelogReleaseSections,
  extractChangelogSection,
  formatShippedBaselineExclusions,
  parseContributionRecordProvenance,
  parseShippedBaselineExclusions,
  releaseNotesSectionForTag,
  releaseNotesVersionForTag,
  renderGithubReleaseNotes,
} from "./render-github-release-notes.mts";
import {
  isShaPinnedReleaseValidationBranch,
  runStrictReleaseEvidenceValidation,
  validateFullReleaseValidationEvidence,
} from "./validate-full-release-validation-evidence.mjs";

type JsonRecord = Record<string, unknown>;
type StringFields<K extends string> = Record<K, string>;
type CandidateState = ReturnType<typeof buildReleaseCandidateState>;
type WorkflowArtifact = Awaited<ReturnType<typeof runArtifacts>>[number];
type GithubFetch = (url: string, init?: RequestInit) => Promise<Response>;
type GithubApiOptions = Partial<{
  fetchImpl: GithubFetch;
  maxBodyBytes: number;
  timeoutMs: number;
  token: string;
}>;
type TarballDescriptor = Record<
  "packageName" | "packageVersion" | "tarballName" | "tarballSha256",
  string
>;
type TelegramArtifact = Partial<WorkflowArtifact>;
type TelegramArtifactParams = {
  artifact: TelegramArtifact;
  manifest: JsonRecord;
  runAttempt: number;
  runId: string;
  sourceSha: string;
};
type TelegramResult = { status: string } & Partial<
  StringFields<"artifactName" | "providerMode" | "runId" | "url">
>;
type LocalCheckResult =
  | { status: "passed"; command: string; reason?: never }
  | { status: "skipped"; reason: string; command?: never };
type PreflightTarballs = Partial<Record<"corePackageTarballs" | "dependencyTarballs", unknown>>;
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
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_CANDIDATE_STATE_VERSION = 2;
const RELEASE_CANDIDATE_STATE_FILE = "release-candidate-state.json";
const TRUSTED_TOOLING_SHA_ENV = "OPENCLAW_RELEASE_CANDIDATE_TRUSTED_TOOLING_SHA";
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
  "parallelsRegistryPackageArtifacts",
  "windowsNodeTag",
  "skipParallels",
  "skipTelegram",
  "telegramProviderMode",
] as const satisfies readonly (keyof CandidateState)[];

function formatJsonValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value) ?? "<undefined>";
}

function usage() {
  return `Usage: pnpm release:candidate -- --tag vYYYY.M.PATCH-beta.N [options]

Dispatches or consumes release validation runs, validates the prepared npm tarball,
builds plugin publish plans, writes a green evidence bundle, then prints the exact
OpenClaw Release Publish command only after everything is green.

Options:
  --tag <tag>                         Planned release tag. The tag must not exist yet.
  --target-sha <sha>                  Frozen release SHA. Defaults to the current HEAD.
  --workflow-ref <ref>                Trusted workflow ref. Default: main; matching Tideclaw branch required for alpha.
  --repo <owner/repo>                 GitHub repo. Default: ${DEFAULT_REPO}
  --full-release-run <id>             Reuse successful Full Release Validation run.
  --npm-preflight-run <id>            Reuse successful OpenClaw NPM Release preflight run.
  --plugin-sdk-api-acknowledgement <digest>
                                      8-character digest from the Plugin SDK API diff report.
  --windows-node-tag <tag>            Exact Windows Node release tag. Required for stable.
  --skip-dispatch                     Require both run ids; do not dispatch workflows.
  --skip-local-generated-check        Do not run local generated release baseline checks before dispatch.
  --run-parallels                    Force candidate Parallels smoke; beta defaults to postpublish release:beta-smoke.
  --skip-parallels                   Force-skip candidate Parallels smoke; stable/full run by default.
  --parallels-registry-package-artifact <dir>
                                      Add a verified plugin npm preflight artifact directory. Repeatable.
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

export function releaseBranchForTag(tag: string) {
  if (tag.includes("-alpha.")) {
    return "";
  }
  const version = tag.replace(/^v/u, "").split("-", 1)[0];
  return `release/${version}`;
}

/**
 * Parses release-candidate validation options and enforces publish-scope policy.
 */
export function parseArgs(argv: string[]) {
  const args = stripLeadingPackageManagerSeparator(argv);
  const terminatorIndex = args.indexOf("--");
  const cliArgs = terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
  const options = {
    repo: DEFAULT_REPO,
    provider: DEFAULT_PROVIDER,
    mode: DEFAULT_MODE,
    releaseProfile: "",
    npmDistTag: DEFAULT_NPM_DIST_TAG,
    pluginPublishScope: DEFAULT_PLUGIN_SCOPE,
    plugins: "",
    parallelsRegistryPackageArtifactDirs: new Array<string>(),
    parallelsRegistryPackageArtifacts: new Array<
      ReturnType<typeof validateParallelsRegistryPackageArtifact>
    >(),
    skipDispatch: false,
    skipLocalGeneratedCheck: false,
    runParallels: false,
    skipParallels: false,
    parallelsMode: "auto" as "auto" | "run" | "skip",
    parallelsSkipReason: "",
    skipTelegram: false,
    telegramProviderMode: DEFAULT_TELEGRAM_PROVIDER_MODE,
    tag: "",
    targetSha: "",
    workflowRef: "",
    fullReleaseRunId: "",
    npmPreflightRunId: "",
    pluginSdkApiAcknowledgement: "",
    windowsNodeTag: "",
    windowsNodeInstallerDigests: "",
    outputDir: "",
  };
  const helpIndex = cliArgs.findIndex((arg) => arg === "-h" || arg === "--help");
  parseFlagArgs(
    helpIndex === -1 ? cliArgs : cliArgs.slice(0, helpIndex),
    options,
    [
      ...(
        [
          ["--tag", "tag"],
          ["--target-sha", "targetSha"],
          ["--workflow-ref", "workflowRef"],
          ["--repo", "repo"],
          ["--full-release-run", "fullReleaseRunId"],
          ["--npm-preflight-run", "npmPreflightRunId"],
          ["--plugin-sdk-api-acknowledgement", "pluginSdkApiAcknowledgement"],
          ["--windows-node-tag", "windowsNodeTag"],
          ["--telegram-provider-mode", "telegramProviderMode"],
          ["--provider", "provider"],
          ["--mode", "mode"],
          ["--release-profile", "releaseProfile"],
          ["--npm-dist-tag", "npmDistTag"],
          ["--plugin-publish-scope", "pluginPublishScope"],
          ["--plugins", "plugins"],
          ["--output-dir", "outputDir"],
        ] satisfies Array<[string, string]>
      ).map(([flag, key]) =>
        stringFlag(flag, key, { allowInline: false, rejectShortOptions: true }),
      ),
      stringListFlag(
        "--parallels-registry-package-artifact",
        "parallelsRegistryPackageArtifactDirs",
        { allowInline: false, rejectShortOptions: true },
      ),
      booleanFlag("--skip-dispatch", "skipDispatch"),
      booleanFlag("--skip-local-generated-check", "skipLocalGeneratedCheck"),
      booleanFlag("--run-parallels", "runParallels"),
      booleanFlag("--skip-parallels", "skipParallels"),
      booleanFlag("--skip-telegram", "skipTelegram"),
    ],
    {
      onUnhandledArg(arg: string) {
        throw new Error(`unknown option: ${arg}`);
      },
    },
  );
  if (helpIndex !== -1) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!options.tag) {
    throw new Error("--tag is required");
  }
  if (options.targetSha && !/^[a-f0-9]{40}$/u.test(options.targetSha)) {
    throw new Error("--target-sha must be a full lowercase commit SHA");
  }
  if (
    options.pluginSdkApiAcknowledgement &&
    !/^[a-f0-9]{8}$/u.test(options.pluginSdkApiAcknowledgement)
  ) {
    throw new Error("--plugin-sdk-api-acknowledgement must be an 8-character lowercase digest");
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
  if (options.runParallels && options.skipParallels) {
    throw new Error("--run-parallels and --skip-parallels cannot be combined");
  }
  options.parallelsMode = options.runParallels ? "run" : options.skipParallels ? "skip" : "auto";
  options.skipParallels =
    options.parallelsMode === "skip" ||
    (options.parallelsMode === "auto" && options.releaseProfile === "beta");
  options.parallelsSkipReason = options.skipParallels
    ? options.parallelsMode === "auto"
      ? "deferred to postpublish release:beta-smoke"
      : "operator skipped --skip-parallels"
    : "";
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

export function run(
  command: string,
  args: string[],
  options: { capture?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
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

function readJson(path: string, label: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) {
      throw new Error("expected an object");
    }
    return value;
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function validateParallelsRegistryPackageArtifact(
  artifactDir: string,
  params: { targetSha: string; targetVersion: string },
) {
  const resolvedDir = resolvePath(artifactDir);
  const manifestPath = join(resolvedDir, "plugin-publication-manifest.json");
  const manifest = readJson(manifestPath, "plugin npm preflight manifest");
  const artifact = isRecord(manifest.artifact) ? manifest.artifact : undefined;
  const packageInfo = isRecord(manifest.package) ? manifest.package : undefined;
  const artifactName = artifact?.name;
  const tarballName = artifact?.tarball;
  const tarballSha256 = artifact?.sha256;
  const packageName = packageInfo?.name;
  const packageVersion = packageInfo?.version;
  if (
    manifest.schema !== "openclaw.plugin-publication-artifact/v1" ||
    manifest.schemaVersion !== 1 ||
    manifest.targetSha !== params.targetSha ||
    typeof artifactName !== "string" ||
    typeof packageName !== "string" ||
    packageVersion !== params.targetVersion ||
    typeof tarballName !== "string" ||
    tarballName !== basename(tarballName) ||
    typeof tarballSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(tarballSha256)
  ) {
    throw new Error(`plugin npm preflight artifact identity is invalid: ${resolvedDir}`);
  }
  const tarballPath = join(resolvedDir, tarballName);
  const compareFileNames = (left: string, right: string) => left.localeCompare(right);
  const files = readdirSync(resolvedDir).toSorted(compareFileNames);
  const expectedFiles = [basename(manifestPath), tarballName].toSorted(compareFileNames);
  if (!isDeepStrictEqual(files, expectedFiles) || !existsSync(tarballPath)) {
    throw new Error(`plugin npm preflight artifact inventory is invalid: ${resolvedDir}`);
  }
  const actualSha256 = sha256(tarballPath);
  if (actualSha256 !== tarballSha256) {
    throw new Error(
      `plugin npm preflight tarball digest mismatch for ${packageName}: expected ${tarballSha256}, got ${actualSha256}`,
    );
  }
  let packedPackage: unknown;
  try {
    packedPackage = JSON.parse(
      run("tar", ["-xOf", tarballPath, "package/package.json"], { capture: true }),
    );
  } catch (error) {
    throw new Error(`plugin npm preflight tarball package metadata is invalid: ${tarballPath}`, {
      cause: error,
    });
  }
  if (
    !isRecord(packedPackage) ||
    packedPackage.name !== packageName ||
    packedPackage.version !== packageVersion
  ) {
    throw new Error(
      `plugin npm preflight tarball identity mismatch: manifest=${packageName}@${packageVersion} packed=${isRecord(packedPackage) ? (packedPackage.name ?? "<missing>") : "<missing>"}@${isRecord(packedPackage) ? (packedPackage.version ?? "<missing>") : "<missing>"}`,
    );
  }
  return {
    artifactDir: resolvedDir,
    artifactName,
    manifestPath,
    packageName,
    packageVersion,
    tarballPath,
    tarballSha256,
  };
}

export function buildReleaseCandidateState(
  options: ReturnType<typeof parseArgs>,
  { targetSha, toolingSha }: { targetSha: string; toolingSha: string },
) {
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
    parallelsRegistryPackageArtifacts: options.parallelsRegistryPackageArtifacts,
    windowsNodeTag: options.windowsNodeTag,
    skipParallels: options.skipParallels,
    skipTelegram: options.skipTelegram,
    telegramProviderMode: options.telegramProviderMode,
    fullReleaseRunId: options.fullReleaseRunId,
    npmPreflightRunId: options.npmPreflightRunId,
  };
}

export function reconcileReleaseCandidateState(saved: unknown, expected: CandidateState) {
  if (!saved) {
    return expected;
  }
  if (!isRecord(saved) || saved.version !== RELEASE_CANDIDATE_STATE_VERSION) {
    throw new Error("release candidate state has an unsupported schema");
  }
  for (const key of RELEASE_CANDIDATE_STATE_KEYS) {
    if (!isDeepStrictEqual(saved[key], expected[key])) {
      throw new Error(
        `release candidate state mismatch for ${key}: saved=${JSON.stringify(saved[key])} current=${JSON.stringify(expected[key])}`,
      );
    }
  }
  for (const key of ["fullReleaseRunId", "npmPreflightRunId"] as const) {
    if (saved[key] && expected[key] && saved[key] !== expected[key]) {
      throw new Error(`release candidate state mismatch for ${key}`);
    }
  }
  return {
    ...expected,
    phase: typeof saved.phase === "string" ? saved.phase : expected.phase,
    fullReleaseRunId:
      expected.fullReleaseRunId ||
      (typeof saved.fullReleaseRunId === "string" ? saved.fullReleaseRunId : ""),
    npmPreflightRunId:
      expected.npmPreflightRunId ||
      (typeof saved.npmPreflightRunId === "string" ? saved.npmPreflightRunId : ""),
  };
}

function writeReleaseCandidateState(path: string, state: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function updateReleaseCandidateState(
  path: string,
  state: CandidateState,
  phase: string,
  runIds: Partial<Pick<CandidateState, "fullReleaseRunId" | "npmPreflightRunId">> = {},
) {
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

function githubApiTimedOut(error: unknown) {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Calls the GitHub REST API with the gh-auth token and a bounded timeout.
 */
export async function githubApi(path: string, options: GithubApiOptions = {}): Promise<unknown> {
  const token = options.token ?? run("gh", ["auth", "token"], { capture: true }).trim();
  const timeoutMs = options.timeoutMs ?? githubApiTimeoutMs();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_GITHUB_API_RESPONSE_BODY_MAX_BYTES;
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = (requestToken: string) =>
    fetchImpl(`https://api.github.com/${path}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
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
export async function validateWindowsSourceRelease(tag: string, options: GithubApiOptions = {}) {
  const release = await githubApi(
    `repos/${WINDOWS_NODE_REPO}/releases/tags/${encodeURIComponent(tag)}`,
    options,
  );
  if (!isRecord(release)) {
    throw new Error(`Windows source release tag mismatch: expected ${tag}, got undefined`);
  }
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

  const releaseAssets = Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
  const assets = WINDOWS_NODE_REQUIRED_ASSETS.map((name) => {
    const matches = releaseAssets.filter((entry) => entry.name === name);
    if (matches.length !== 1) {
      throw new Error(
        `Windows source release ${tag} must contain exactly one required asset ${name}; found ${matches.length}`,
      );
    }
    const [asset] = matches;
    if (!asset) {
      throw new Error(`Windows source release ${tag} is missing required asset ${name}`);
    }
    if (typeof asset.digest !== "string" || !SHA256_DIGEST_PATTERN.test(asset.digest)) {
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

function gitRevParse(ref: string, cwd: string = process.cwd()) {
  return run("git", ["rev-parse", ref], { capture: true, cwd }).trim();
}

function gitTopLevel(cwd: string) {
  return run("git", ["rev-parse", "--show-toplevel"], { capture: true, cwd }).trim();
}

function gitTrackedStatus(cwd: string) {
  return run("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    capture: true,
    cwd,
  });
}

function fetchTrustedWorkflowSha(workflowRef: string, toolingRoot: string) {
  const remoteRef = `refs/remotes/origin/${workflowRef}`;
  run("git", ["fetch", "--no-tags", "origin", `+refs/heads/${workflowRef}:${remoteRef}`], {
    cwd: toolingRoot,
  });
  return gitRevParse(`${remoteRef}^{commit}`, toolingRoot);
}

function runFromTrustedTooling(
  argv: string[],
  { targetRoot, workflowRef }: { targetRoot: string; workflowRef: string },
) {
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
      ["--import", "tsx", join(toolingRoot, "scripts/release-candidate-checklist.mts"), ...argv],
      {
        cwd: targetRoot,
        env: { ...process.env, [TRUSTED_TOOLING_SHA_ENV]: trustedToolingSha },
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

export function isDirectReleaseCandidateExecution(
  directPath: string | undefined,
  modulePath: string,
  resolveRealPath: (path: string) => string = realpathSync,
) {
  if (!directPath) {
    return false;
  }
  try {
    return resolveRealPath(directPath) === resolveRealPath(modulePath);
  } catch {
    return false;
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
}: StringFields<
  | "targetSha"
  | "targetHeadSha"
  | "targetTrackedStatus"
  | "toolingSha"
  | "trustedToolingSha"
  | "toolingTrackedStatus"
  | "workflowRef"
>) {
  if (targetHeadSha !== targetSha) {
    throw new Error(
      `release candidate target is ${targetSha}, but target worktree HEAD is ${targetHeadSha}`,
    );
  }
  if (targetTrackedStatus.trim()) {
    throw new Error(
      "release candidate validation requires a clean tracked target worktree at the frozen release SHA",
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

/**
 * Keeps release validation pre-publication: the final immutable tag is created
 * only after this helper has recorded green evidence for the frozen SHA.
 */
export function assertPlannedReleaseTagIsAbsent(
  tag: string,
  checkRemoteTagExists: (tag: string) => boolean,
) {
  if (checkRemoteTagExists(tag)) {
    throw new Error(
      `release candidate tag ${tag} already exists; validate a new patch instead of reusing a published tag`,
    );
  }
}

function remoteTagExists(tag: string, cwd: string) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 2) {
    return false;
  }
  throw new Error(
    `could not determine whether planned release tag ${tag} already exists: ${result.stderr.trim() || result.stdout.trim() || `git exited ${result.status ?? "without a status"}`}`,
  );
}

function gitIsAncestor(ancestor: string, target: string) {
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

export function validateTrustedToolingPin({
  toolingSha,
  pinnedToolingSha,
  latestTrustedToolingSha,
  isAncestor = gitIsAncestor,
}: {
  toolingSha: string;
  pinnedToolingSha: string;
  latestTrustedToolingSha: string;
  isAncestor?: (ancestor: string, target: string) => boolean;
}) {
  if (!/^[a-f0-9]{40}$/u.test(pinnedToolingSha)) {
    throw new Error("release candidate trusted tooling pin is missing or invalid");
  }
  if (toolingSha !== pinnedToolingSha) {
    throw new Error(
      `release candidate tooling HEAD ${toolingSha} does not match pinned tooling ${pinnedToolingSha}`,
    );
  }
  if (
    pinnedToolingSha !== latestTrustedToolingSha &&
    !isAncestor(pinnedToolingSha, latestTrustedToolingSha)
  ) {
    throw new Error(
      `pinned release candidate tooling ${pinnedToolingSha} is not reachable from trusted workflow tip ${latestTrustedToolingSha}`,
    );
  }
  return pinnedToolingSha;
}

export function validateNpmPreflightRunSource({
  workflowRun,
  workflowRef,
  isTrustedWorkflowAncestor = gitIsAncestor,
}: {
  workflowRun: { headSha: string };
  workflowRef: string;
  isTrustedWorkflowAncestor?: (ancestor: string, target: string) => boolean;
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
  section: string,
  label: string,
  { requireExactProvenance = true }: { requireExactProvenance?: boolean } = {},
) {
  const recordStart = section.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    throw new Error(`${label} is missing ### Complete contribution record`);
  }
  const record = section.slice(recordStart);
  const rowNumbers = [...record.matchAll(/^- \*\*PR #(?<number>[0-9]+)\*\*/gmu)].map((match) =>
    Number(match.groups?.number),
  );
  const rows = new Set(rowNumbers);
  if (rows.size !== rowNumbers.length) {
    const duplicate = rowNumbers.find((number, index) => rowNumbers.indexOf(number) !== index);
    throw new Error(`${label} contains duplicate contribution record PR #${duplicate}`);
  }
  if (!requireExactProvenance) {
    return rows;
  }
  const provenance = parseContributionRecordProvenance(record);
  if (!provenance || !/^[0-9a-f]{40}$/u.test(provenance.target)) {
    throw new Error(`${label} is missing exact complete contribution record provenance`);
  }
  return rows;
}

export function candidateCumulativeShippedPullRequests(changelog: string, label: string) {
  const pullRequests = new Set<number>();
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

function requireString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function loadCandidateShippedBaseline(ref: string) {
  const tagRef = `refs/tags/${ref}`;
  gitRevParse(`${tagRef}^{commit}`);
  const changelog = run("git", ["show", `${tagRef}:CHANGELOG.md`], { capture: true });
  const version = requireString(releaseNotesVersionForTag(ref), "release notes version");
  candidateContributionRecordPullRequests(
    requireString(extractChangelogSection(changelog, version), "changelog section"),
    `shipped baseline ${ref}`,
  );
  const pullRequests = candidateCumulativeShippedPullRequests(changelog, `shipped baseline ${ref}`);
  return { ref, pullRequests };
}

export function validateCandidateReleaseNotes({
  changelog,
  repository,
  tag,
}: StringFields<"changelog" | "repository" | "tag">) {
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
}: {
  changelog: string;
  version: string;
  tag: string;
  targetSha: string;
  isAncestor?: (ancestor: string, target: string) => boolean;
  loadShippedBaseline?: (ref: string) => { pullRequests: Set<number> };
}) {
  // Validate the same section the renderer publishes: alpha and correction
  // tags may carry their own heading, and alpha tags may fall back to
  // Unreleased.
  let section: string | undefined;
  let sectionVersion = version;
  let usesAlphaUnreleasedFallback = false;
  const dedicatedVersion = dedicatedSectionVersionForTag(tag);
  if (typeof dedicatedVersion === "string" && dedicatedVersion !== version) {
    try {
      section = requireString(
        extractChangelogSection(changelog, dedicatedVersion),
        "changelog section",
      );
      sectionVersion = dedicatedVersion;
    } catch {
      // No dedicated section; validate the base section.
    }
  }
  if (section === undefined) {
    try {
      section = requireString(extractChangelogSection(changelog, version), "changelog section");
    } catch (error) {
      if (!/-alpha\.[1-9][0-9]*$/u.test(tag)) {
        throw error;
      }
      section = requireString(
        releaseNotesSectionForTag(changelog, version, tag),
        "release notes section",
      );
      usesAlphaUnreleasedFallback = true;
    }
  }
  if (section === undefined) {
    throw new Error(`CHANGELOG.md ## ${sectionVersion} could not be resolved`);
  }
  const recordStart = section.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    if (usesAlphaUnreleasedFallback) {
      return {
        status: "skipped",
        reason: "alpha release uses the explicit Unreleased fallback",
        shippedBaselines: [],
        base: undefined,
        target: undefined,
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
  const provenance = parseContributionRecordProvenance(record);
  const base = provenance?.base;
  const recordedTarget = provenance?.target;
  if (!base || !recordedTarget || !/^[0-9a-f]{40}$/u.test(recordedTarget)) {
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
  const excludedPullRequests = new Set<number>();
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
  return {
    status: "passed",
    base,
    target: recordedTarget,
    shippedBaselines,
    reason: undefined,
  };
}

async function runArtifacts(repo: string, runId: string) {
  const data = await githubApi(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts = isRecord(data) && Array.isArray(data.artifacts) ? data.artifacts : [];
  return artifacts.flatMap((artifact) => {
    if (!isRecord(artifact) || typeof artifact.name !== "string") {
      return [];
    }
    const workflowRun = isRecord(artifact.workflow_run) ? artifact.workflow_run : undefined;
    return [
      {
        digest: typeof artifact.digest === "string" ? artifact.digest : undefined,
        expired: typeof artifact.expired === "boolean" ? artifact.expired : undefined,
        id: typeof artifact.id === "number" ? artifact.id : undefined,
        name: artifact.name,
        workflowRunId: typeof workflowRun?.id === "number" ? workflowRun.id : undefined,
      },
    ];
  });
}

/**
 * Chooses the expected artifact name, allowing one same-prefix fallback per run.
 */
export function resolveArtifactName(
  artifacts: Array<{ expired?: boolean; name: string }>,
  preferredName: string,
  prefix: string,
) {
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

async function resolveRunArtifact(
  repo: string,
  runId: string,
  preferredName: string,
  prefix: string,
) {
  const artifacts = await runArtifacts(repo, runId);
  const name = resolveArtifactName(artifacts, preferredName, prefix);
  const artifact = artifacts.find((candidate) => candidate.name === name);
  if (!artifact) {
    throw new Error(`resolved artifact ${name} disappeared from run ${runId}`);
  }
  return artifact;
}

function runAndEcho(command: string, args: string[]) {
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

function runLocalGeneratedCheckIfNeeded(options: ReturnType<typeof parseArgs>): LocalCheckResult {
  if (options.skipLocalGeneratedCheck) {
    return { status: "skipped", reason: "operator skipped --skip-local-generated-check" };
  }
  run("pnpm", ["release:generated:check"]);
  return { status: "passed", command: "pnpm release:generated:check" };
}

/**
 * Extracts a GitHub Actions run id from gh workflow dispatch output.
 */
export function parseRunIdFromDispatchOutput(output: string) {
  return output.match(/actions\/runs\/([0-9]+)/u)?.[1] ?? "";
}

export function requireRunIdFromDispatchOutput(output: string, workflowFile: string) {
  const runId = parseRunIdFromDispatchOutput(output);
  if (!runId) {
    throw new Error(
      `gh workflow run ${workflowFile} did not return an Actions run URL; refusing to guess from recent workflow_dispatch runs`,
    );
  }
  return runId;
}

export function fullReleaseTrustedWorkflowFields({
  workflowRef,
  workflowSha,
  workflowSource,
}: {
  workflowRef: string;
  workflowSha: string;
  workflowSource: string;
}) {
  const workflow: unknown = parseYaml(workflowSource);
  const env = isRecord(workflow) && isRecord(workflow.env) ? workflow.env : undefined;
  const contract = String(env?.RELEASE_ISOLATION_TOOLING_CONTRACT ?? "");
  if (contract === "1") {
    return {};
  }
  if (contract !== "2") {
    throw new Error(
      "Full Release Validation does not declare a supported release tooling contract",
    );
  }
  const workflowDispatch =
    isRecord(workflow) && isRecord(workflow.on) && isRecord(workflow.on.workflow_dispatch)
      ? workflow.on.workflow_dispatch
      : undefined;
  const inputs =
    workflowDispatch && isRecord(workflowDispatch.inputs) ? workflowDispatch.inputs : undefined;
  if (!inputs || !Object.hasOwn(inputs, "trusted_workflow_json")) {
    throw new Error(`Full Release Validation contract ${contract} requires trusted_workflow_json`);
  }
  if (!/^[a-f0-9]{40}$/u.test(workflowSha)) {
    throw new Error("Full Release Validation trusted workflow SHA must be a full lowercase SHA");
  }
  return {
    trusted_workflow_json: JSON.stringify({
      ref: workflowRef,
      fullRef: `refs/heads/${workflowRef}`,
      sha: workflowSha,
    }),
  };
}

async function wait(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dispatchWorkflow(
  repo: string,
  workflowFile: string,
  workflowRef: string,
  fields: Record<string, unknown>,
) {
  const args = ["workflow", "run", workflowFile, "--repo", repo, "--ref", workflowRef];
  for (const [key, value] of Object.entries(fields)) {
    args.push("-f", `${key}=${String(value)}`);
  }
  return requireRunIdFromDispatchOutput(runAndEcho("gh", args), workflowFile);
}

async function runInfo(repo: string, runId: string) {
  const [runData, jobsData] = await Promise.all([
    githubApi(`repos/${repo}/actions/runs/${runId}`),
    githubApi(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`),
  ]);
  if (!isRecord(runData) || !isRecord(jobsData)) {
    throw new Error(`run ${runId} returned invalid GitHub API data`);
  }
  const repository = isRecord(runData.repository) ? runData.repository : undefined;
  const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs.filter(isRecord) : [];
  return {
    databaseId: typeof runData.id === "number" ? runData.id : undefined,
    runAttempt: typeof runData.run_attempt === "number" ? runData.run_attempt : 0,
    workflowName: typeof runData.name === "string" ? runData.name : undefined,
    workflowPath: runData.path,
    repository: repository?.full_name,
    headBranch: typeof runData.head_branch === "string" ? runData.head_branch : undefined,
    headSha: typeof runData.head_sha === "string" ? runData.head_sha : "",
    event: runData.event,
    status: typeof runData.status === "string" ? runData.status : undefined,
    conclusion: typeof runData.conclusion === "string" ? runData.conclusion : undefined,
    url: typeof runData.html_url === "string" ? runData.html_url : undefined,
    jobs: jobs.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.html_url,
    })),
  };
}
type RunInfo = Awaited<ReturnType<typeof runInfo>>;

async function pendingDeployments(repo: string, runId: string) {
  try {
    return await githubApi(`repos/${repo}/actions/runs/${runId}/pending_deployments`);
  } catch {
    return [];
  }
}

function summarizePendingDeployments(repo: string, runId: string, deployments: unknown) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return "";
  }
  return deployments
    .map((deploymentValue) => {
      const deployment = isRecord(deploymentValue) ? deploymentValue : {};
      const environment = isRecord(deployment.environment) ? deployment.environment : {};
      return [
        `- pending approval: env=${environment.name ?? "<unknown>"} canApprove=${String(deployment.current_user_can_approve ?? "<unknown>")}`,
        `  approve: gh api -X POST repos/${repo}/actions/runs/${runId}/pending_deployments -F 'environment_ids[]=${environment.id ?? "<id>"}' -f state=approved -f comment='Approve release gate'`,
      ].join("\n");
    })
    .join("\n");
}

function summarizeFailedRun(info: RunInfo) {
  const failedJobs = (info.jobs ?? []).filter(
    (job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped",
  );
  return [
    `${info.workflowName} ${info.databaseId} ended ${info.status}/${info.conclusion}: ${info.url}`,
    ...failedJobs.map((job) => `- ${job.name}: ${job.conclusion} ${job.url ?? ""}`),
  ].join("\n");
}

async function waitForSuccessfulRun(
  repo: string,
  runId: string,
  expected: { allowShaPinnedWorkflowRef?: boolean; workflowName: string; workflowRef: string },
) {
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

function downloadArtifact(repo: string, runId: string, name: string, dir: string) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  run("gh", ["run", "download", runId, "--repo", repo, "--name", name, "--dir", dir]);
}

async function downloadResolvedArtifact(
  repo: string,
  runId: string,
  preferredName: string,
  prefix: string,
  dir: string,
) {
  const artifact = await resolveRunArtifact(repo, runId, preferredName, prefix);
  downloadArtifact(repo, runId, artifact.name, dir);
  return artifact;
}

function sha256(path: string) {
  return run("shasum", ["-a", "256", path], { capture: true }).trim().split(/\s+/u)[0] ?? "";
}

function pluginPlanArgs(options: ReturnType<typeof parseArgs>) {
  const args = ["--selection-mode", options.pluginPublishScope];
  if (options.pluginPublishScope === "selected") {
    args.push("--plugins", options.plugins);
  }
  return args;
}

function collectPluginPlan(script: string, options: ReturnType<typeof parseArgs>): unknown {
  return JSON.parse(
    run("node", ["--import", "tsx", script, ...pluginPlanArgs(options)], { capture: true }),
  );
}

async function collectPluginPlanWithRetry(script: string, options: ReturnType<typeof parseArgs>) {
  let lastError: unknown;
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

function pluginPlanPackageCount(plan: unknown) {
  return isRecord(plan) && Array.isArray(plan.packages) ? plan.packages.length : 0;
}

function shellQuote(value: unknown) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

/**
 * Builds the final release publish workflow command once validation evidence is ready.
 */
export function buildPublishCommand(
  options: ReturnType<typeof parseArgs> & {
    fullReleaseRunAttempt?: number;
    npmTelegramRunId?: string;
  },
) {
  const workflowRef = options.tag.includes("-alpha.") ? options.workflowRef : "main";
  if (options.tag.includes("-alpha.") && !TIDECLAW_ALPHA_WORKFLOW_REF_PATTERN.test(workflowRef)) {
    throw new Error(
      "alpha release publish requires a matching tideclaw/alpha/YYYY-MM-DD-HHMMZ workflow ref",
    );
  }
  const fields: Array<[string, string | number | undefined]> = [
    ["tag", options.tag],
    ["preflight_run_id", options.npmPreflightRunId],
    ["plugin_sdk_api_acknowledgement", options.pluginSdkApiAcknowledgement],
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
    ...fields.flatMap(([key, value]) => ["-f", `${key}=${String(value)}`]),
  ]
    .map(shellQuote)
    .join(" ");
}

export function validatePreflightManifest(manifest: JsonRecord, params: JsonRecord) {
  if (manifest.releaseTag !== params.tag) {
    throw new Error(
      `npm preflight tag mismatch: expected ${formatJsonValue(params.tag)}, got ${formatJsonValue(manifest.releaseTag)}`,
    );
  }
  if (manifest.releaseSha !== params.targetSha) {
    throw new Error(
      `npm preflight SHA mismatch: expected ${formatJsonValue(params.targetSha)}, got ${formatJsonValue(manifest.releaseSha)}`,
    );
  }
  if (manifest.npmDistTag !== params.npmDistTag) {
    throw new Error(
      `npm preflight dist-tag mismatch: expected ${formatJsonValue(params.npmDistTag)}, got ${formatJsonValue(manifest.npmDistTag)}`,
    );
  }
  if (!manifest.tarballName || !manifest.tarballSha256) {
    throw new Error("npm preflight manifest missing tarball metadata");
  }
  const corePackageTarballs = preflightCorePackageTarballs(manifest);
  const dependencyTarballs = preflightDependencyTarballs(manifest);
  for (const dependency of [...corePackageTarballs, ...dependencyTarballs]) {
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
  const corePackageDescriptors = new Set(corePackageTarballs.map(preflightTarballDescriptorKey));
  for (const dependency of dependencyTarballs) {
    if (!corePackageDescriptors.has(preflightTarballDescriptorKey(dependency))) {
      throw new Error(
        `npm preflight dependency tarball metadata does not match the core package manifest: ${dependency.packageName}`,
      );
    }
  }
}

function preflightTarballDescriptorKey(tarball: TarballDescriptor) {
  return JSON.stringify([
    tarball.packageName,
    tarball.packageVersion,
    tarball.tarballName,
    tarball.tarballSha256,
  ]);
}

function isTarballDescriptor(value: unknown): value is TarballDescriptor {
  return (
    isRecord(value) &&
    typeof value.packageName === "string" &&
    typeof value.packageVersion === "string" &&
    typeof value.tarballName === "string" &&
    typeof value.tarballSha256 === "string"
  );
}

function preflightTarballs(
  manifest: PreflightTarballs,
  preferred: "corePackageTarballs" | "dependencyTarballs",
  fallback: "corePackageTarballs" | "dependencyTarballs",
) {
  const tarballs = Object.hasOwn(manifest, preferred) ? manifest[preferred] : manifest[fallback];
  if (!Array.isArray(tarballs) || !tarballs.every(isTarballDescriptor)) {
    throw new Error("npm preflight manifest missing dependency tarball metadata");
  }
  return tarballs;
}

export function preflightCorePackageTarballs(manifest: PreflightTarballs) {
  return preflightTarballs(manifest, "corePackageTarballs", "dependencyTarballs");
}

export function preflightDependencyTarballs(manifest: PreflightTarballs) {
  return preflightTarballs(manifest, "dependencyTarballs", "corePackageTarballs");
}

export function validateFullManifest(manifest: JsonRecord, params: JsonRecord) {
  if (manifest.workflowName !== "Full Release Validation") {
    throw new Error(`full validation workflow mismatch: ${formatJsonValue(manifest.workflowName)}`);
  }
  if (manifest.targetSha !== params.targetSha) {
    throw new Error(
      `full validation SHA mismatch: expected ${formatJsonValue(params.targetSha)}, got ${formatJsonValue(manifest.targetSha)}`,
    );
  }
  if (manifest.releaseProfile !== params.releaseProfile) {
    throw new Error(
      `full validation profile mismatch: expected ${formatJsonValue(params.releaseProfile)}, got ${formatJsonValue(manifest.releaseProfile)}`,
    );
  }
  if (manifest.rerunGroup !== "all") {
    throw new Error(
      `full validation must use rerun_group=all, got ${formatJsonValue(manifest.rerunGroup)}`,
    );
  }
  if (
    (params.releaseProfile === "stable" || params.releaseProfile === "full") &&
    manifest.runReleaseSoak !== "true"
  ) {
    throw new Error(
      `full validation must record runReleaseSoak=true for ${formatJsonValue(params.releaseProfile)} release candidates`,
    );
  }
  const controls = isRecord(manifest.controls) ? manifest.controls : undefined;
  if (params.releaseProfile !== "beta" && controls?.performanceBlocking !== true) {
    throw new Error("full validation manifest must record blocking product performance evidence");
  }
}

export function candidateParallelsArgs(
  tarballPath: string,
  dependencyTarballPaths: string[] = [],
  toolingRoot = TOOLING_ROOT,
  registryPackageTarballPaths: string[] = [],
  macosSnapshotHint = "",
) {
  return [
    "exec",
    "tsx",
    join(toolingRoot, "scripts/e2e/parallels/npm-update-smoke.ts"),
    "--target-tarball",
    tarballPath,
    ...dependencyTarballPaths.flatMap((dependency) => ["--dependency-tarball", dependency]),
    ...registryPackageTarballPaths.flatMap((registryPackage) => [
      "--registry-package-tarball",
      registryPackage,
    ]),
    ...(macosSnapshotHint ? ["--macos-snapshot-hint", macosSnapshotHint] : []),
    "--json",
  ];
}

export function candidateParallelsShellCommand(
  tarballPath: string,
  timeoutBin: string,
  dependencyTarballPaths: string[] = [],
  registryPackageTarballPaths: string[] = [],
  macosSnapshotHint = "",
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
    ...candidateParallelsArgs(
      tarballPath,
      dependencyTarballPaths,
      TOOLING_ROOT,
      registryPackageTarballPaths,
      macosSnapshotHint,
    ).map(shellQuote),
  ].join(" ");
}

async function runParallelsIfNeeded(
  options: ReturnType<typeof parseArgs>,
  tarballPath: string,
  dependencyTarballPaths: string[],
  registryPackageTarballPaths: string[],
): Promise<LocalCheckResult> {
  if (options.skipParallels) {
    return { status: "skipped", reason: options.parallelsSkipReason };
  }
  // This function runs inside trusted tooling, not the frozen target checkout.
  // Prepare its isolated dependencies here before importing the Parallels harness.
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"], {
    cwd: TOOLING_ROOT,
  });
  const timeoutBin = run("bash", ["-lc", "command -v gtimeout || command -v timeout"], {
    capture: true,
  }).trim();
  const command = candidateParallelsShellCommand(
    tarballPath,
    timeoutBin,
    dependencyTarballPaths,
    registryPackageTarballPaths,
    process.env.OPENCLAW_PARALLELS_MACOS_SNAPSHOT_HINT?.trim() ?? "",
  );
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

export function buildTelegramArtifactInputs({
  artifact,
  manifest,
  runAttempt,
  runId,
  sourceSha,
}: TelegramArtifactParams) {
  const artifactDigest = artifact.digest?.match(/^sha256:([0-9a-f]{64})$/u)?.[1];
  if (
    typeof artifact.id !== "number" ||
    !Number.isInteger(artifact.id) ||
    artifact.id < 1 ||
    !artifactDigest
  ) {
    throw new Error(`npm preflight artifact ${artifact.name} is missing immutable identity`);
  }
  if (String(artifact.workflowRunId) !== runId) {
    throw new Error(
      `npm preflight artifact ${artifact.name} belongs to run ${artifact.workflowRunId}, not ${runId}`,
    );
  }
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error(`npm preflight run ${runId} has invalid attempt`);
  }
  if (
    !artifact.name ||
    typeof manifest.tarballName !== "string" ||
    typeof manifest.tarballSha256 !== "string" ||
    typeof manifest.packageVersion !== "string"
  ) {
    throw new Error("npm preflight artifact manifest is incomplete");
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

async function runTelegramIfNeeded(
  options: ReturnType<typeof parseArgs>,
  artifact: TelegramArtifact,
  manifest: JsonRecord,
  runAttempt: number,
  sourceSha: string,
): Promise<TelegramResult> {
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
  const targetSha = gitRevParse(options.targetSha || "HEAD", targetRoot);
  assertPlannedReleaseTagIsAbsent(options.tag, (tag) => remoteTagExists(tag, targetRoot));
  const toolingSha = gitRevParse("HEAD", TOOLING_ROOT);
  const latestTrustedToolingSha = fetchTrustedWorkflowSha(options.workflowRef, TOOLING_ROOT);
  // The outer process pins a clean main commit before creating this tooling checkout.
  // A newer main tip must not invalidate that immutable, still-trusted ancestor mid-run.
  const trustedToolingSha = validateTrustedToolingPin({
    toolingSha,
    pinnedToolingSha: process.env[TRUSTED_TOOLING_SHA_ENV] ?? latestTrustedToolingSha,
    latestTrustedToolingSha,
  });
  validateCandidateCheckout({
    targetSha,
    targetHeadSha: gitRevParse("HEAD", targetRoot),
    targetTrackedStatus: gitTrackedStatus(targetRoot),
    toolingSha,
    trustedToolingSha,
    toolingTrackedStatus: gitTrackedStatus(TOOLING_ROOT),
    workflowRef: options.workflowRef,
  });
  options.parallelsRegistryPackageArtifacts = options.parallelsRegistryPackageArtifactDirs.map(
    (artifactDir) =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha,
        targetVersion: options.tag.replace(/^v/u, ""),
      }),
  );
  const registryPackageNames = new Set(
    options.parallelsRegistryPackageArtifacts.map((artifact) => artifact.packageName),
  );
  if (registryPackageNames.size !== options.parallelsRegistryPackageArtifacts.length) {
    throw new Error("Parallels registry package artifacts must have unique package names");
  }
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
    const trustedWorkflowFields = fullReleaseTrustedWorkflowFields({
      workflowRef: options.workflowRef,
      workflowSha: toolingSha,
      workflowSource: readFileSync(
        join(TOOLING_ROOT, ".github", "workflows", workflowFile),
        "utf8",
      ),
    });
    options.fullReleaseRunId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
      ref: targetSha,
      ...(targetContextRef ? { target_context_ref: targetContextRef } : {}),
      ...trustedWorkflowFields,
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
      tag: targetSha,
      preflight_only: "true",
      npm_dist_tag: options.npmDistTag,
      plugin_sdk_api_acknowledgement: options.pluginSdkApiAcknowledgement,
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
    workflowRun: { headSha: npmRun.headSha },
    workflowRef: options.workflowRef,
  });

  const npmDir = join(options.outputDir, "npm-preflight");
  const pluginSdkApiDir = join(options.outputDir, "plugin-sdk-api-evidence");
  const fullDir = join(options.outputDir, "full-release-validation");
  const npmArtifact = await downloadResolvedArtifact(
    options.repo,
    options.npmPreflightRunId,
    `openclaw-npm-preflight-${options.tag}`,
    "openclaw-npm-preflight-",
    npmDir,
  );
  const npmArtifactName = npmArtifact.name;
  if (!Number.isInteger(npmRun.runAttempt) || npmRun.runAttempt < 1) {
    throw new Error(`OpenClaw npm preflight run ${options.npmPreflightRunId} has invalid attempt.`);
  }
  downloadArtifact(
    options.repo,
    options.npmPreflightRunId,
    `plugin-sdk-api-release-diff-${options.npmPreflightRunId}-${npmRun.runAttempt}`,
    pluginSdkApiDir,
  );
  if (!Number.isInteger(fullRun.runAttempt) || fullRun.runAttempt < 1) {
    throw new Error(`Full Release Validation run ${options.fullReleaseRunId} has invalid attempt.`);
  }
  const fullArtifactName = `full-release-validation-${options.fullReleaseRunId}-${fullRun.runAttempt}`;
  downloadArtifact(options.repo, options.fullReleaseRunId, fullArtifactName, fullDir);

  const npmManifest = readJson(join(npmDir, "preflight-manifest.json"), "npm preflight manifest");
  const immutablePluginSdkApiEvidence = readJson(
    join(pluginSdkApiDir, "plugin-sdk-api-release-evidence.json"),
    "immutable Plugin SDK API evidence",
  );
  if (!isDeepStrictEqual(npmManifest.pluginSdkApi, immutablePluginSdkApiEvidence)) {
    throw new Error(
      "npm preflight manifest Plugin SDK API evidence does not match its immutable artifact",
    );
  }
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
    isTrustedMainAncestor: (sha: string) => gitIsAncestor(sha, "refs/remotes/origin/main"),
    validateEvidenceReuseStrictly: ({ repository, runId }: { repository: string; runId: string }) =>
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
  const pluginSdkApiValidation = validatePluginSdkApiReleaseEvidence({
    acknowledgement: options.pluginSdkApiAcknowledgement,
    evidence: npmManifest.pluginSdkApi,
    expectedHeadSha: targetSha,
    expectedWorkflowSha: npmRun.headSha,
  });
  validateFullManifest(fullManifest, {
    targetSha,
    releaseProfile: options.releaseProfile,
  });
  const tarballPath = join(
    npmDir,
    requireString(npmManifest.tarballName, "npm preflight tarball name"),
  );
  if (!existsSync(tarballPath)) {
    throw new Error(`prepared tarball missing: ${tarballPath}`);
  }
  const actualTarballSha = sha256(tarballPath);
  if (actualTarballSha !== npmManifest.tarballSha256) {
    throw new Error(
      `prepared tarball digest mismatch: expected ${npmManifest.tarballSha256}, got ${actualTarballSha}`,
    );
  }
  const corePackageTarballPaths = new Map(
    preflightCorePackageTarballs(npmManifest).map((dependency) => {
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
      return [preflightTarballDescriptorKey(dependency), dependencyPath];
    }),
  );
  const dependencyTarballPaths = preflightDependencyTarballs(npmManifest).map((dependency) => {
    const dependencyPath = corePackageTarballPaths.get(preflightTarballDescriptorKey(dependency));
    if (!dependencyPath) {
      throw new Error(
        `prepared dependency tarball is missing from the core package manifest: ${dependency.tarballName}`,
      );
    }
    return dependencyPath;
  });

  const revalidatedRegistryArtifacts = options.parallelsRegistryPackageArtifactDirs.map(
    (artifactDir) =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha,
        targetVersion: options.tag.replace(/^v/u, ""),
      }),
  );
  if (!isDeepStrictEqual(revalidatedRegistryArtifacts, options.parallelsRegistryPackageArtifacts)) {
    throw new Error("Parallels registry package artifacts changed during candidate validation");
  }
  const parallels = await runParallelsIfNeeded(
    options,
    tarballPath,
    dependencyTarballPaths,
    revalidatedRegistryArtifacts.map((artifact) => artifact.tarballPath),
  );
  const npmTelegram = await runTelegramIfNeeded(
    options,
    npmArtifact,
    npmManifest,
    npmRun.runAttempt,
    targetSha,
  );
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
    npmTelegramRunId: npmTelegram.runId,
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
    pluginSdkApi: npmManifest.pluginSdkApi,
    pluginSdkApiValidation,
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
    parallelsRegistryPackageArtifacts: revalidatedRegistryArtifacts,
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
      `- Plugin SDK API evidence: ${pluginSdkApiValidation.status}${
        pluginSdkApiValidation.digest ? ` (${pluginSdkApiValidation.digest})` : ""
      }`,
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
      `- plugin npm plan: ${pluginPlanPackageCount(pluginNpmPlan)} packages`,
      `- ClawHub plan: ${pluginPlanPackageCount(pluginClawHubPlan)} packages`,
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

if (isDirectReleaseCandidateExecution(process.argv[1], fileURLToPath(import.meta.url))) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

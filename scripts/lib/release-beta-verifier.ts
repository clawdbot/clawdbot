import { execFileSync } from "node:child_process";
// Release Beta Verifier script supports OpenClaw repository automation.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPublicationArtifactArchive, sha256Digest } from "./actions-artifact-archive.mjs";
import { readBoundedResponseText } from "./bounded-response.ts";
import { collectClawHubPublishablePluginPackages } from "./plugin-clawhub-release.ts";
import {
  collectPublishablePluginPackages,
  parsePluginReleaseSelection,
} from "./plugin-npm-release.ts";

type JsonRecord = Record<string, unknown>;

type ReleaseVerifyBetaArgs = {
  version: string;
  tag: string;
  distTag: string;
  repo: string;
  registry: string;
  releaseSha?: string;
  workflowRef?: string;
  clawHubWorkflowRef?: string;
  pluginSelection: string[];
  clawHubBootstrapPlugins: string[];
  evidenceOut?: string;
  skipPostpublish: boolean;
  skipGitHubRelease: boolean;
  skipClawHub: boolean;
  rerunFailedClawHub: boolean;
  workflowRuns: {
    fullReleaseValidation?: string;
    openclawNpm?: string;
    pluginNpm?: string;
    pluginClawHub?: string;
    pluginClawHubBootstrap?: string;
    npmTelegram?: string;
  };
};

type NpmViewFields = {
  version?: string;
  distTagVersion?: string;
  integrity?: string;
  tarball?: string;
};

type FetchWithRetryResult = {
  response: Response;
  signal: AbortSignal;
};

type WorkflowRunSummary = {
  id: string;
  label: string;
  url?: string;
  durationSeconds?: number;
  bootstrapEvidence?: {
    targetSha: string;
    workflowSha: string;
    workflowPath: string;
    producerRunAttempt: string;
    terminalRunAttempt: string;
    readbackArtifactId: string;
    readbackArtifactDigest: string;
    packageArtifactId: string;
    packageArtifactDigest: string;
    packageCount: number;
    clawhubToolchainIntegrity: string;
    clawhubToolchainSha256: string;
    clawhubToolchainVersion: string;
  };
};

const DEFAULT_REPO = "openclaw/openclaw";
const DEFAULT_CLAWHUB_REGISTRY = "https://clawhub.ai";
const CLAWHUB_BOOTSTRAP_WORKFLOW_PATH = ".github/workflows/plugin-clawhub-new.yml";
const CLAWHUB_BOOTSTRAP_READBACK_FILE = "clawhub-bootstrap-readback.json";
const CLAWHUB_REQUEST_TIMEOUT_MS = 20_000;
const CLAWHUB_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;
const CLAWHUB_BOOTSTRAP_READBACK_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const TRUSTED_TOOLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Trusted publish can finish before npm registry metadata converges. Keep the
// verifier on the same release train instead of forcing a republish/correction.
const NPM_VIEW_ATTEMPTS = 30;
const NPM_VIEW_RETRY_MAX_DELAY_MS = 10_000;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireString(value: unknown, label: string): string {
  const stringValue = readString(value);
  if (stringValue === undefined) {
    throw new Error(`${label} is missing.`);
  }
  return stringValue;
}

function readTrustedClawHubToolchainIdentity(): {
  clawhubToolchainIntegrity: string;
  clawhubToolchainSha256: string;
  clawhubToolchainVersion: string;
} {
  const lockPath = resolve(TRUSTED_TOOLING_ROOT, ".github/release/clawhub-cli/package-lock.json");
  const lockBytes = readFileSync(lockPath);
  const lock = parseJson(lockBytes.toString("utf8"), "trusted ClawHub CLI package-lock.json");
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    throw new Error("Trusted ClawHub CLI package-lock.json is invalid.");
  }
  const clawhub = lock.packages["node_modules/clawhub"];
  if (!isRecord(clawhub)) {
    throw new Error("Trusted ClawHub CLI package-lock.json is missing clawhub.");
  }
  const clawhubToolchainIntegrity = requireString(
    clawhub.integrity,
    "trusted ClawHub CLI integrity",
  );
  if (!SHA512_INTEGRITY_PATTERN.test(clawhubToolchainIntegrity)) {
    throw new Error("Trusted ClawHub CLI integrity is invalid.");
  }
  return {
    clawhubToolchainIntegrity,
    clawhubToolchainSha256: createHash("sha256").update(lockBytes).digest("hex"),
    clawhubToolchainVersion: requireString(clawhub.version, "trusted ClawHub CLI version"),
  };
}

function runCommand(command: string, args: string[], options: { cwd?: string } = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runCommandInherited(command: string, args: string[]): void {
  execFileSync(command, args, {
    stdio: "inherit",
  });
}

export async function runNpmViewWithRetry(
  args: string[],
  options: {
    attempts?: number;
    delay?: (delayMs: number) => Promise<void>;
    run?: (args: string[]) => string;
  } = {},
): Promise<string> {
  const attempts = options.attempts ?? NPM_VIEW_ATTEMPTS;
  const delay =
    options.delay ??
    ((delayMs: number) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, delayMs);
      }));
  const run = options.run ?? ((npmArgs: string[]) => runCommand("npm", npmArgs));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run([...args, "--prefer-online"]);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await delay(Math.min(attempt * 1000, NPM_VIEW_RETRY_MAX_DELAY_MS));
    }
  }

  throw lastError;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}`, { cause: error });
  }
}

export function parseNpmViewFields(raw: string, distTag: string): NpmViewFields {
  const parsed = parseJson(raw, "npm view");
  if (Array.isArray(parsed)) {
    return {
      version: readString(parsed[0]),
      distTagVersion: readString(parsed[1]),
      integrity: readString(parsed[2]),
      tarball: readString(parsed[3]),
    };
  }
  if (!isRecord(parsed)) {
    throw new Error("npm view returned an unsupported JSON shape.");
  }
  const distTags = isRecord(parsed["dist-tags"]) ? parsed["dist-tags"] : undefined;
  const dist = isRecord(parsed.dist) ? parsed.dist : undefined;
  return {
    version: readString(parsed.version),
    distTagVersion: readString(parsed[`dist-tags.${distTag}`]) ?? readString(distTags?.[distTag]),
    integrity: readString(parsed["dist.integrity"]) ?? readString(dist?.integrity),
    tarball: readString(parsed["dist.tarball"]) ?? readString(dist?.tarball),
  };
}

export function parseReleaseVerifyBetaArgs(argv: string[]): ReleaseVerifyBetaArgs {
  const values = [...argv];
  if (values[0] === "--") {
    values.shift();
  }
  const version = values.shift();
  if (!version || version.startsWith("-")) {
    throw new Error(
      "Usage: pnpm release:verify-beta -- <version> [--release-sha SHA] [--workflow-ref REF] [--clawhub-workflow-ref REF] [--full-release-validation-run ID] [--openclaw-npm-run ID] [--plugin-npm-run ID] [--plugin-clawhub-run ID] [--plugin-clawhub-bootstrap-run ID --clawhub-bootstrap-plugins NAMES] [--npm-telegram-run ID] [--skip-github-release] [--skip-clawhub]",
    );
  }

  const parsed: ReleaseVerifyBetaArgs = {
    version,
    tag: `v${version}`,
    distTag: "beta",
    repo: DEFAULT_REPO,
    registry: DEFAULT_CLAWHUB_REGISTRY,
    releaseSha: undefined,
    workflowRef: undefined,
    clawHubWorkflowRef: undefined,
    pluginSelection: [],
    clawHubBootstrapPlugins: [],
    evidenceOut: undefined,
    skipPostpublish: false,
    skipGitHubRelease: false,
    skipClawHub: false,
    rerunFailedClawHub: false,
    workflowRuns: {},
  };

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--tag":
        parsed.tag = next();
        break;
      case "--dist-tag":
        parsed.distTag = next();
        break;
      case "--repo":
        parsed.repo = next();
        break;
      case "--registry":
        parsed.registry = next();
        break;
      case "--release-sha":
        parsed.releaseSha = next();
        if (!COMMIT_SHA_PATTERN.test(parsed.releaseSha)) {
          throw new Error("--release-sha must be a full 40-character lowercase commit SHA.");
        }
        break;
      case "--workflow-ref":
        parsed.workflowRef = next();
        break;
      case "--clawhub-workflow-ref":
        parsed.clawHubWorkflowRef = next();
        break;
      case "--plugins":
        parsed.pluginSelection = parsePluginReleaseSelection(next());
        if (parsed.pluginSelection.length === 0) {
          throw new Error("--plugins requires at least one plugin package name.");
        }
        break;
      case "--clawhub-bootstrap-plugins":
        parsed.clawHubBootstrapPlugins = parsePluginReleaseSelection(next());
        if (parsed.clawHubBootstrapPlugins.length === 0) {
          throw new Error("--clawhub-bootstrap-plugins requires at least one package name.");
        }
        break;
      case "--evidence-out":
        parsed.evidenceOut = next();
        break;
      case "--full-release-validation-run":
        parsed.workflowRuns.fullReleaseValidation = next();
        break;
      case "--openclaw-npm-run":
        parsed.workflowRuns.openclawNpm = next();
        break;
      case "--plugin-npm-run":
        parsed.workflowRuns.pluginNpm = next();
        break;
      case "--plugin-clawhub-run":
        parsed.workflowRuns.pluginClawHub = next();
        break;
      case "--plugin-clawhub-bootstrap-run":
        parsed.workflowRuns.pluginClawHubBootstrap = next();
        break;
      case "--npm-telegram-run":
        parsed.workflowRuns.npmTelegram = next();
        break;
      case "--skip-postpublish":
        parsed.skipPostpublish = true;
        break;
      case "--skip-github-release":
        parsed.skipGitHubRelease = true;
        break;
      case "--skip-clawhub":
        parsed.skipClawHub = true;
        break;
      case "--rerun-failed-clawhub":
        parsed.rerunFailedClawHub = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.workflowRuns.pluginClawHubBootstrap !== undefined) {
    if (parsed.releaseSha === undefined) {
      throw new Error("--plugin-clawhub-bootstrap-run requires --release-sha.");
    }
    if (parsed.clawHubBootstrapPlugins.length === 0) {
      throw new Error("--plugin-clawhub-bootstrap-run requires --clawhub-bootstrap-plugins.");
    }
  } else if (parsed.clawHubBootstrapPlugins.length > 0) {
    throw new Error("--clawhub-bootstrap-plugins requires --plugin-clawhub-bootstrap-run.");
  }

  return parsed;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempts: number,
): Promise<FetchWithRetryResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const signal = AbortSignal.timeout(CLAWHUB_REQUEST_TIMEOUT_MS);
      const response = await fetch(url, {
        ...options,
        signal,
      });
      if (response.status !== 429 && response.status < 500) {
        return { response, signal };
      }
      await cancelResponseBody(response);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, attempt * 1000);
      });
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${url} did not return a stable response: ${message}`);
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function fetchJsonWithRetry(
  url: string,
  options: {
    attempts?: number;
    delay?: (delayMs: number) => Promise<void>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 5;
  const delay =
    options.delay ??
    ((delayMs: number) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, delayMs);
      }));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? CLAWHUB_REQUEST_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | undefined;
    let attemptError: unknown;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal,
      });
      if (response.status !== 429 && response.status < 500) {
        if (!response.ok) {
          await cancelResponseBody(response);
          throw new Error(`${url} returned HTTP ${response.status}.`);
        }
        return await readBoundedJsonResponse(response, url, undefined, { signal });
      }
      attemptError = new Error(`HTTP ${response.status}`);
      lastError = attemptError;
    } catch (error) {
      if (
        response !== undefined &&
        response.status !== 429 &&
        response.status < 500 &&
        !response.ok
      ) {
        throw error;
      }
      attemptError = error;
      lastError = error;
    } finally {
      if (response !== undefined && attemptError !== undefined) {
        await cancelResponseBody(response);
      }
    }
    if (attempt < attempts) {
      await delay(attempt * 1000);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${url} did not return stable JSON: ${message}`);
}

export async function readBoundedJsonResponse(
  response: Response,
  label: string,
  maxBytes = CLAWHUB_RESPONSE_BODY_MAX_BYTES,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  return parseJson(await readBoundedResponseText(response, label, maxBytes, options), label);
}

export async function fetchStatusWithRetry(url: string, method: "GET" | "HEAD"): Promise<number> {
  const { response } = await fetchWithRetry(url, { method, redirect: "manual" }, 5);
  try {
    return response.status;
  } finally {
    await cancelResponseBody(response);
  }
}

async function verifyNpmPackage(
  packageName: string,
  version: string,
  distTag: string,
): Promise<NpmViewFields> {
  const raw = await runNpmViewWithRetry([
    "view",
    `${packageName}@${version}`,
    "version",
    `dist-tags.${distTag}`,
    "dist.integrity",
    "dist.tarball",
    "--json",
  ]);
  const fields = parseNpmViewFields(raw, distTag);
  if (fields.version !== version) {
    throw new Error(
      `${packageName}: expected npm version ${version}, got ${fields.version ?? "<missing>"}.`,
    );
  }
  if (fields.distTagVersion !== version) {
    throw new Error(
      `${packageName}: npm dist-tag ${distTag} points to ${fields.distTagVersion ?? "<missing>"}, expected ${version}.`,
    );
  }
  if (fields.integrity === undefined) {
    throw new Error(`${packageName}: npm dist.integrity missing for ${version}.`);
  }
  if (fields.tarball === undefined) {
    throw new Error(`${packageName}: npm dist.tarball missing for ${version}.`);
  }
  return fields;
}

function readClawHubTags(detail: unknown): Record<string, string> {
  if (!isRecord(detail)) {
    return {};
  }
  const packageDetail = isRecord(detail.package) ? detail.package : undefined;
  const tags = isRecord(packageDetail?.tags) ? packageDetail.tags : undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

async function verifyClawHubPackage(params: {
  registry: string;
  packageName: string;
  version: string;
  distTag: string;
}): Promise<void> {
  const base = params.registry.replace(/\/+$/u, "");
  const encodedName = encodeURIComponent(params.packageName);
  const encodedVersion = encodeURIComponent(params.version);
  const detailUrl = `${base}/api/v1/packages/${encodedName}`;
  const versionUrl = `${detailUrl}/versions/${encodedVersion}`;
  const artifactUrl = `${versionUrl}/artifact/download`;

  const detail = await fetchJsonWithRetry(detailUrl);
  const tags = readClawHubTags(detail);
  if (tags[params.distTag] !== params.version) {
    throw new Error(
      `${params.packageName}: ClawHub tag ${params.distTag} points to ${tags[params.distTag] ?? "<missing>"}, expected ${params.version}.`,
    );
  }

  const versionStatus = await fetchStatusWithRetry(versionUrl, "GET");
  if (versionStatus < 200 || versionStatus >= 300) {
    throw new Error(`${params.packageName}: ClawHub exact version returned HTTP ${versionStatus}.`);
  }

  const artifactStatus = await fetchStatusWithRetry(artifactUrl, "HEAD");
  if (artifactStatus < 200 || artifactStatus >= 400) {
    throw new Error(`${params.packageName}: ClawHub artifact returned HTTP ${artifactStatus}.`);
  }
}

function verifyGitHubRelease(params: ReleaseVerifyBetaArgs): string {
  const raw = runCommand("gh", [
    "release",
    "view",
    params.tag,
    "--repo",
    params.repo,
    "--json",
    "tagName,isPrerelease,url",
  ]);
  const release = parseJson(raw, "gh release view");
  if (!isRecord(release)) {
    throw new Error("GitHub release returned an unsupported JSON shape.");
  }
  if (release.tagName !== params.tag) {
    throw new Error(
      `GitHub release tag mismatch: expected ${params.tag}, got ${String(release.tagName)}.`,
    );
  }
  if (params.version.includes("-beta.") && release.isPrerelease !== true) {
    throw new Error(`${params.tag} is not marked as a GitHub prerelease.`);
  }
  return requireString(release.url, "GitHub release URL");
}

function verifyWorkflowRun(params: {
  id: string;
  label: string;
  repo: string;
  expectedWorkflowName: string;
  expectedHeadBranch?: string;
  allowedHeadBranches?: string[];
  rerunFailed: boolean;
}): WorkflowRunSummary {
  const raw = runCommand("gh", [
    "run",
    "view",
    params.id,
    "--repo",
    params.repo,
    "--json",
    "workflowName,headBranch,event,status,conclusion,url,createdAt,updatedAt,jobs",
  ]);
  const run = parseJson(raw, `gh run view ${params.id}`);
  if (!isRecord(run)) {
    throw new Error(`${params.label}: workflow run returned an unsupported JSON shape.`);
  }
  const workflowName = readString(run.workflowName);
  if (workflowName !== params.expectedWorkflowName) {
    throw new Error(
      `${params.label}: run ${params.id} workflow is ${workflowName ?? "<missing>"}, expected ${params.expectedWorkflowName}.`,
    );
  }
  const event = readString(run.event);
  if (event !== "workflow_dispatch") {
    throw new Error(
      `${params.label}: run ${params.id} event is ${event ?? "<missing>"}, expected workflow_dispatch.`,
    );
  }
  const headBranch = readString(run.headBranch);
  const allowedHeadBranches =
    params.allowedHeadBranches ??
    (params.expectedHeadBranch !== undefined ? [params.expectedHeadBranch] : []);
  if (allowedHeadBranches.length > 0 && !allowedHeadBranches.includes(headBranch ?? "")) {
    throw new Error(
      `${params.label}: run ${params.id} branch is ${headBranch ?? "<missing>"}, expected ${allowedHeadBranches.join(" or ")}.`,
    );
  }
  const status = readString(run.status);
  const conclusion = readString(run.conclusion);
  const jobs = Array.isArray(run.jobs) ? run.jobs.filter(isRecord) : [];
  const failedJobs = jobs.filter((job) => {
    const jobConclusion = readString(job.conclusion);
    return (
      jobConclusion !== undefined && jobConclusion !== "success" && jobConclusion !== "skipped"
    );
  });
  if (failedJobs.length > 0 && params.rerunFailed) {
    runCommandInherited("gh", ["run", "rerun", params.id, "--repo", params.repo, "--failed"]);
    throw new Error(
      `${params.label}: reran ${failedJobs.length} failed job(s); rerun verifier after it finishes.`,
    );
  }
  if (status !== "completed" || conclusion !== "success" || failedJobs.length > 0) {
    const failedNames = failedJobs.map((job) => readString(job.name) ?? "<unnamed>").join(", ");
    throw new Error(
      `${params.label}: run ${params.id} is ${status ?? "<missing>"}/${conclusion ?? "<missing>"}${failedNames ? `; failed jobs: ${failedNames}` : ""}.`,
    );
  }
  const createdAt = readString(run.createdAt);
  const updatedAt = readString(run.updatedAt);
  const createdMs = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const updatedMs = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
  const durationSeconds =
    Number.isFinite(createdMs) && Number.isFinite(updatedMs)
      ? Math.max(0, Math.round((updatedMs - createdMs) / 1000))
      : undefined;
  return {
    id: params.id,
    label: params.label,
    url: readString(run.url),
    durationSeconds,
  };
}

function requirePositiveIntegerString(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  const stringValue = readString(value);
  if (stringValue === undefined || !POSITIVE_INTEGER_PATTERN.test(stringValue)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return stringValue;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const stringValue = requirePositiveIntegerString(value, label);
  const numberValue = Number(stringValue);
  if (!Number.isSafeInteger(numberValue)) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return numberValue;
}

function requireCommitSha(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`${label} must be a full 40-character lowercase commit SHA.`);
  }
  return sha;
}

function requireSha256(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!SHA256_PATTERN.test(sha)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return sha;
}

function requireArtifactDigest(value: unknown, label: string): string {
  const digest = requireString(value, label);
  const match = /^sha256:([a-f0-9]{64})$/u.exec(digest);
  if (!match?.[1]) {
    throw new Error(`${label} must be a sha256 artifact digest.`);
  }
  return match[1];
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value
    .map((entry) => entry.trim())
    .filter(Boolean)
    .toSorted(compareCodeUnits);
}

function requireArtifactWorkflowRun(
  artifact: JsonRecord,
  params: { label: string; runId: string; headSha: string },
): void {
  if (artifact.expired !== false) {
    throw new Error(`${params.label} is expired or missing its immutable state.`);
  }
  const workflowRun = artifact.workflow_run;
  if (!isRecord(workflowRun)) {
    throw new Error(`${params.label} is missing workflow_run metadata.`);
  }
  if (
    requirePositiveIntegerString(workflowRun.id, `${params.label} workflow run id`) !== params.runId
  ) {
    throw new Error(`${params.label} belongs to a different workflow run.`);
  }
  if (
    requireCommitSha(workflowRun.head_sha, `${params.label} workflow head SHA`) !== params.headSha
  ) {
    throw new Error(`${params.label} belongs to a different workflow head SHA.`);
  }
  if (requireString(workflowRun.head_branch, `${params.label} workflow head branch`) !== "main") {
    throw new Error(`${params.label} was not produced by trusted main.`);
  }
}

function requireClawHubBootstrapRunBinding(
  run: unknown,
  expectedRunId: string,
): {
  headSha: string;
  run: JsonRecord;
  runAttempt: number;
  runId: number;
  terminalRunAttempt: string;
  workflowPath: string;
} {
  if (!isRecord(run)) {
    throw new Error("Plugin ClawHub New run metadata is invalid.");
  }
  const runId = requirePositiveSafeInteger(run.id, "Plugin ClawHub New run id");
  if (String(runId) !== expectedRunId) {
    throw new Error(`Plugin ClawHub New run id is ${runId}, expected ${expectedRunId}.`);
  }
  if (run.name !== "Plugin ClawHub New") {
    throw new Error("Plugin ClawHub New run has an unexpected workflow name.");
  }
  if (run.event !== "workflow_dispatch") {
    throw new Error("Plugin ClawHub New run was not workflow_dispatch.");
  }
  if (run.head_branch !== "main") {
    throw new Error("Plugin ClawHub New run was not dispatched from trusted main.");
  }
  const headSha = requireCommitSha(run.head_sha, "Plugin ClawHub New head SHA");
  const runAttempt = requirePositiveSafeInteger(run.run_attempt, "Plugin ClawHub New run attempt");
  const workflowPath = requireString(run.path, "Plugin ClawHub New workflow path").replace(
    /@.*$/u,
    "",
  );
  if (workflowPath !== CLAWHUB_BOOTSTRAP_WORKFLOW_PATH) {
    throw new Error("Plugin ClawHub New run has an unexpected workflow path.");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Plugin ClawHub New run is not completed/success.");
  }
  return {
    headSha,
    run,
    runAttempt,
    runId,
    terminalRunAttempt: String(runAttempt),
    workflowPath,
  };
}

function requireClawHubReadbackArtifactBinding(
  artifact: unknown,
  run: ReturnType<typeof requireClawHubBootstrapRunBinding>,
): {
  artifactDigest: string;
  artifactId: number;
  artifactName: string;
  artifactSizeBytes: number;
} {
  if (!isRecord(artifact)) {
    throw new Error("Plugin ClawHub New readback artifact metadata is invalid.");
  }
  const artifactName = `clawhub-bootstrap-readback-${run.runId}-${run.terminalRunAttempt}`;
  if (artifact.name !== artifactName) {
    throw new Error("Plugin ClawHub New readback artifact name does not bind the run attempt.");
  }
  requireArtifactWorkflowRun(artifact, {
    label: "Plugin ClawHub New readback artifact",
    runId: String(run.runId),
    headSha: run.headSha,
  });
  return {
    artifactDigest: `sha256:${requireArtifactDigest(
      artifact.digest,
      "Plugin ClawHub New readback artifact digest",
    )}`,
    artifactId: requirePositiveSafeInteger(artifact.id, "Plugin ClawHub New readback artifact id"),
    artifactName,
    artifactSizeBytes: requirePositiveSafeInteger(
      artifact.size_in_bytes,
      "Plugin ClawHub New readback artifact size",
    ),
  };
}

function validateBootstrapPackageEvidence(
  value: unknown,
  params: { packageName: string; version: string },
): void {
  if (!isRecord(value)) {
    throw new Error(`${params.packageName} bootstrap evidence is invalid.`);
  }
  if (
    requireString(value.packageName, `${params.packageName} package name`) !== params.packageName
  ) {
    throw new Error(`${params.packageName} bootstrap evidence package mismatch.`);
  }
  if (requireString(value.version, `${params.packageName} version`) !== params.version) {
    throw new Error(`${params.packageName} bootstrap evidence version mismatch.`);
  }
  const expectedSha256 = requireSha256(
    value.expectedSha256,
    `${params.packageName} expected sha256`,
  );
  if (
    requireSha256(value.registrySha256, `${params.packageName} registry sha256`) !== expectedSha256
  ) {
    throw new Error(
      `${params.packageName} registry artifact digest differs from the packed artifact.`,
    );
  }
  const expectedSize = value.expectedSize;
  const registrySize = value.registrySize;
  if (
    typeof expectedSize !== "number" ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    registrySize !== expectedSize
  ) {
    throw new Error(
      `${params.packageName} registry artifact size differs from the packed artifact.`,
    );
  }
  const npmIntegrity = requireString(value.npmIntegrity, `${params.packageName} npm integrity`);
  const npmShasum = requireString(value.npmShasum, `${params.packageName} npm shasum`);
  const metadata = value.artifactMetadata;
  if (!isRecord(metadata)) {
    throw new Error(`${params.packageName} artifact metadata evidence is invalid.`);
  }
  if (metadata.kind !== "npm-pack") {
    throw new Error(`${params.packageName} artifact metadata is not npm-pack.`);
  }
  if (
    requireString(metadata.packageName, `${params.packageName} metadata package name`) !==
      params.packageName ||
    requireString(metadata.version, `${params.packageName} metadata version`) !== params.version
  ) {
    throw new Error(`${params.packageName} artifact metadata identity mismatch.`);
  }
  if (
    requireSha256(metadata.sha256, `${params.packageName} metadata sha256`) !== expectedSha256 ||
    metadata.size !== expectedSize ||
    metadata.npmIntegrity !== npmIntegrity ||
    metadata.npmShasum !== npmShasum
  ) {
    throw new Error(`${params.packageName} artifact metadata does not match downloaded bytes.`);
  }
}

export function validateClawHubBootstrapEvidence(params: {
  repo: string;
  runId: string;
  releaseSha: string;
  expectedVersion: string;
  expectedPackages: string[];
  run: unknown;
  readbackArtifact: unknown;
  readbackArchiveSha256: string;
  packageArtifact: unknown;
  evidence: unknown;
}): WorkflowRunSummary {
  const runBinding = requireClawHubBootstrapRunBinding(params.run, params.runId);
  const { headSha, terminalRunAttempt, workflowPath } = runBinding;
  const runId = String(runBinding.runId);
  const readbackBinding = requireClawHubReadbackArtifactBinding(
    params.readbackArtifact,
    runBinding,
  );
  const readbackArtifactId = String(readbackBinding.artifactId);
  const readbackArtifactDigest = requireArtifactDigest(
    readbackBinding.artifactDigest,
    "Plugin ClawHub New readback artifact digest",
  );
  if (
    requireSha256(params.readbackArchiveSha256, "Downloaded readback artifact sha256") !==
    readbackArtifactDigest
  ) {
    throw new Error("Downloaded Plugin ClawHub New readback artifact digest mismatch.");
  }

  if (!isRecord(params.evidence)) {
    throw new Error("Plugin ClawHub New readback evidence is invalid.");
  }
  if (params.evidence.schemaVersion !== 2 || params.evidence.verificationMode !== "postpublish") {
    throw new Error("Plugin ClawHub New readback evidence schema or mode is invalid.");
  }
  if (params.evidence.repository !== params.repo) {
    throw new Error("Plugin ClawHub New readback evidence repository mismatch.");
  }
  if (
    requireCommitSha(params.evidence.targetSha, "Plugin ClawHub New target SHA") !==
    params.releaseSha
  ) {
    throw new Error("Plugin ClawHub New readback evidence target SHA mismatch.");
  }
  if (
    requireCommitSha(params.evidence.workflowSha, "Plugin ClawHub New workflow SHA") !== headSha
  ) {
    throw new Error("Plugin ClawHub New readback evidence workflow SHA mismatch.");
  }
  const evidenceRunId = requirePositiveIntegerString(
    params.evidence.runId,
    "Plugin ClawHub New evidence run id",
  );
  const producerRunAttempt = requirePositiveIntegerString(
    params.evidence.producerRunAttempt,
    "Plugin ClawHub New evidence producer run attempt",
  );
  const evidenceTerminalRunAttempt = requirePositiveIntegerString(
    params.evidence.terminalRunAttempt,
    "Plugin ClawHub New evidence terminal run attempt",
  );
  if (evidenceRunId !== runId || evidenceTerminalRunAttempt !== terminalRunAttempt) {
    throw new Error("Plugin ClawHub New readback evidence run tuple mismatch.");
  }
  if (BigInt(producerRunAttempt) > BigInt(terminalRunAttempt)) {
    throw new Error("Plugin ClawHub New producer attempt is newer than its terminal attempt.");
  }
  const expectedToolchain = readTrustedClawHubToolchainIdentity();
  for (const [key, expected] of Object.entries(expectedToolchain)) {
    if (params.evidence[key] !== expected) {
      throw new Error(`Plugin ClawHub New ${key} mismatch.`);
    }
  }

  const expectedPackages = [...new Set(params.expectedPackages)].toSorted(compareCodeUnits);
  if (expectedPackages.length === 0) {
    throw new Error("Plugin ClawHub New expected package set is empty.");
  }
  if (
    JSON.stringify(
      requireStringArray(params.evidence.requestedPlugins, "requested bootstrap plugins"),
    ) !== JSON.stringify(expectedPackages)
  ) {
    throw new Error("Plugin ClawHub New requested package set mismatch.");
  }
  if (!Array.isArray(params.evidence.packages)) {
    throw new Error("Plugin ClawHub New package evidence is invalid.");
  }
  const evidencePackages = params.evidence.packages
    .map((entry) =>
      isRecord(entry) ? requireString(entry.packageName, "bootstrap package name") : "",
    )
    .toSorted(compareCodeUnits);
  if (JSON.stringify(evidencePackages) !== JSON.stringify(expectedPackages)) {
    throw new Error("Plugin ClawHub New terminal package set mismatch.");
  }
  for (const packageName of expectedPackages) {
    validateBootstrapPackageEvidence(
      params.evidence.packages.find(
        (entry) => isRecord(entry) && entry.packageName === packageName,
      ),
      { packageName, version: params.expectedVersion },
    );
  }

  if (!isRecord(params.packageArtifact)) {
    throw new Error("Plugin ClawHub New package artifact metadata is invalid.");
  }
  const packageArtifactId = requirePositiveIntegerString(
    params.packageArtifact.id,
    "Plugin ClawHub New package artifact id",
  );
  if (
    packageArtifactId !==
    requirePositiveIntegerString(
      params.evidence.artifactId,
      "Plugin ClawHub New evidence package artifact id",
    )
  ) {
    throw new Error("Plugin ClawHub New package artifact id mismatch.");
  }
  if (
    params.packageArtifact.name !==
    requireString(params.evidence.artifactName, "Plugin ClawHub New package artifact name")
  ) {
    throw new Error("Plugin ClawHub New package artifact name mismatch.");
  }
  requireArtifactWorkflowRun(params.packageArtifact, {
    label: "Plugin ClawHub New package artifact",
    runId,
    headSha,
  });
  const packageArtifactDigest = requireArtifactDigest(
    params.packageArtifact.digest,
    "Plugin ClawHub New package artifact digest",
  );
  if (
    packageArtifactDigest !==
    requireSha256(
      params.evidence.artifactDigest,
      "Plugin ClawHub New evidence package artifact digest",
    )
  ) {
    throw new Error("Plugin ClawHub New package artifact digest mismatch.");
  }
  const expectedPackageArtifactName = `clawhub-bootstrap-${params.releaseSha.slice(0, 12)}-${runId}-${producerRunAttempt}`;
  if (params.packageArtifact.name !== expectedPackageArtifactName) {
    throw new Error(
      "Plugin ClawHub New package artifact name does not bind the target and attempt.",
    );
  }

  const createdAt = readString(runBinding.run.created_at);
  const updatedAt = readString(runBinding.run.updated_at);
  const createdMs = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const updatedMs = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
  return {
    id: runId,
    label: "Plugin ClawHub New",
    url: readString(runBinding.run.html_url),
    durationSeconds:
      Number.isFinite(createdMs) && Number.isFinite(updatedMs)
        ? Math.max(0, Math.round((updatedMs - createdMs) / 1000))
        : undefined,
    bootstrapEvidence: {
      targetSha: params.releaseSha,
      workflowSha: headSha,
      workflowPath,
      producerRunAttempt,
      terminalRunAttempt,
      readbackArtifactId,
      readbackArtifactDigest,
      packageArtifactId,
      packageArtifactDigest,
      packageCount: expectedPackages.length,
      ...expectedToolchain,
    },
  };
}

function readGitHubApiJson(repo: string, endpoint: string, label: string): unknown {
  return parseJson(runCommand("gh", ["api", `repos/${repo}/${endpoint}`]), label);
}

function readGitHubToken(): string {
  return requireString(
    process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? runCommand("gh", ["auth", "token"]),
    "GitHub token",
  );
}

function decodeUtf8Exact(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonically encoded UTF-8.`);
  }
  return value;
}

export async function downloadClawHubBootstrapReadback(params: {
  repo: string;
  runId: string;
  run: unknown;
  readbackArtifact: unknown;
  token: string;
  fetchImpl?: typeof fetch;
  retryAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}): Promise<{ value: unknown; archiveSha256: string }> {
  const runBinding = requireClawHubBootstrapRunBinding(params.run, params.runId);
  const artifactBinding = requireClawHubReadbackArtifactBinding(
    params.readbackArtifact,
    runBinding,
  );
  const downloaded = await readPublicationArtifactArchive({
    archivePolicy: {
      expectedEntries: [CLAWHUB_BOOTSTRAP_READBACK_FILE],
      maxArchiveBytes: CLAWHUB_BOOTSTRAP_READBACK_ARCHIVE_MAX_BYTES,
      maxExpandedBytes: CLAWHUB_RESPONSE_BODY_MAX_BYTES,
      maxCompressedEntryBytes: () => CLAWHUB_BOOTSTRAP_READBACK_ARCHIVE_MAX_BYTES,
      maxEntryBytes: () => CLAWHUB_RESPONSE_BODY_MAX_BYTES,
    },
    expected: {
      artifactDigest: artifactBinding.artifactDigest,
      artifactId: artifactBinding.artifactId,
      artifactName: artifactBinding.artifactName,
      artifactSizeBytes: artifactBinding.artifactSizeBytes,
      repository: params.repo,
      runStatePolicy: "completed-success",
      runAttempt: runBinding.runAttempt,
      runId: runBinding.runId,
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: "main",
      workflowPath: runBinding.workflowPath,
      workflowSha: runBinding.headSha,
    },
    fetchImpl: params.fetchImpl,
    maxArchiveBytes: CLAWHUB_BOOTSTRAP_READBACK_ARCHIVE_MAX_BYTES,
    retryAttempts: params.retryAttempts,
    retryDelayMs: params.retryDelayMs,
    timeoutMs: params.timeoutMs,
    token: params.token,
  });
  const bytes = downloaded.files.get(CLAWHUB_BOOTSTRAP_READBACK_FILE);
  if (!bytes) {
    throw new Error("Plugin ClawHub New readback artifact is missing its evidence file.");
  }
  return {
    value: parseJson(
      decodeUtf8Exact(bytes, "Plugin ClawHub New readback artifact"),
      "Plugin ClawHub New readback artifact",
    ),
    archiveSha256: requireArtifactDigest(
      sha256Digest(downloaded.archiveBytes),
      "Downloaded Plugin ClawHub New readback artifact digest",
    ),
  };
}

async function verifyClawHubBootstrapRun(params: {
  repo: string;
  runId: string;
  releaseSha: string;
  version: string;
  expectedPackages: string[];
}): Promise<WorkflowRunSummary> {
  const run = readGitHubApiJson(
    params.repo,
    `actions/runs/${params.runId}`,
    "Plugin ClawHub New run",
  );
  const runBinding = requireClawHubBootstrapRunBinding(run, params.runId);
  const terminalRunAttempt = runBinding.terminalRunAttempt;
  const readbackName = `clawhub-bootstrap-readback-${params.runId}-${terminalRunAttempt}`;
  const artifactList = readGitHubApiJson(
    params.repo,
    `actions/runs/${params.runId}/artifacts?per_page=100&name=${encodeURIComponent(readbackName)}`,
    "Plugin ClawHub New readback artifact list",
  );
  if (!isRecord(artifactList) || !Array.isArray(artifactList.artifacts)) {
    throw new Error("Plugin ClawHub New readback artifact list is invalid.");
  }
  const readbackArtifacts = artifactList.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.name === readbackName,
  );
  if (readbackArtifacts.length !== 1 || !isRecord(readbackArtifacts[0])) {
    throw new Error(
      `Plugin ClawHub New run must have exactly one ${readbackName} artifact; found ${readbackArtifacts.length}.`,
    );
  }
  const readbackArtifact = readbackArtifacts[0];
  const downloaded = await downloadClawHubBootstrapReadback({
    repo: params.repo,
    runId: params.runId,
    run,
    readbackArtifact,
    token: readGitHubToken(),
  });
  if (!isRecord(downloaded.value)) {
    throw new Error("Plugin ClawHub New readback evidence is invalid.");
  }
  const packageArtifactId = requirePositiveIntegerString(
    downloaded.value.artifactId,
    "Plugin ClawHub New package artifact id",
  );
  const packageArtifact = readGitHubApiJson(
    params.repo,
    `actions/artifacts/${packageArtifactId}`,
    "Plugin ClawHub New package artifact",
  );
  return validateClawHubBootstrapEvidence({
    repo: params.repo,
    runId: params.runId,
    releaseSha: params.releaseSha,
    expectedVersion: params.version,
    expectedPackages: params.expectedPackages,
    run,
    readbackArtifact,
    readbackArchiveSha256: downloaded.archiveSha256,
    packageArtifact,
    evidence: downloaded.value,
  });
}

function readRootPackageVersion(rootDir: string): string {
  const packageJson = parseJson(
    readFileSync(resolve(rootDir, "package.json"), "utf8"),
    "package.json",
  );
  if (!isRecord(packageJson)) {
    throw new Error("package.json returned an unsupported JSON shape.");
  }
  return requireString(packageJson.version, "package.json version");
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) {
    return "unknown";
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

function assertSelectedPackagesResolved(params: {
  label: string;
  selection: readonly string[];
  packages: readonly { packageName: string }[];
}): void {
  if (params.selection.length === 0) {
    return;
  }
  const resolved = new Set(params.packages.map((plugin) => plugin.packageName));
  const missing = params.selection.filter((packageName) => !resolved.has(packageName));
  if (missing.length > 0) {
    throw new Error(`Unknown or non-publishable ${params.label} selection: ${missing.join(", ")}.`);
  }
}

export async function verifyBetaRelease(
  args: ReleaseVerifyBetaArgs,
  options: { rootDir?: string } = {},
): Promise<string[]> {
  const rootDir = options.rootDir ?? resolve(".");
  const rootVersion = readRootPackageVersion(rootDir);
  if (rootVersion !== args.version) {
    throw new Error(`package.json version is ${rootVersion}; expected ${args.version}.`);
  }
  if (args.releaseSha !== undefined) {
    const checkedOutSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: rootDir });
    if (checkedOutSha !== args.releaseSha) {
      throw new Error(`release checkout SHA is ${checkedOutSha}; expected ${args.releaseSha}.`);
    }
  }

  const lines: string[] = [];
  const releaseUrl = args.skipGitHubRelease ? undefined : verifyGitHubRelease(args);
  if (releaseUrl === undefined) {
    lines.push("GitHub release skipped: final release page is created after verification");
  } else {
    lines.push(`GitHub release OK: ${releaseUrl}`);
  }

  const openclawNpm = await verifyNpmPackage("openclaw", args.version, args.distTag);
  lines.push(`openclaw npm OK: ${args.version} (${args.distTag})`);

  if (!args.skipPostpublish) {
    runCommandInherited("node", [
      "--import",
      "tsx",
      "scripts/openclaw-npm-postpublish-verify.ts",
      args.version,
    ]);
    lines.push("openclaw postpublish verifier OK");
  }

  const npmPlugins = collectPublishablePluginPackages(rootDir, {
    packageNames: args.pluginSelection.length > 0 ? args.pluginSelection : undefined,
  });
  assertSelectedPackagesResolved({
    label: "npm plugin",
    selection: args.pluginSelection,
    packages: npmPlugins,
  });
  for (const plugin of npmPlugins) {
    await verifyNpmPackage(plugin.packageName, args.version, args.distTag);
  }
  lines.push(`plugin npm OK: ${npmPlugins.length}`);

  const clawHubPlugins = args.skipClawHub
    ? []
    : collectClawHubPublishablePluginPackages(rootDir, {
        packageNames: args.pluginSelection.length > 0 ? args.pluginSelection : undefined,
      });
  if (args.skipClawHub) {
    lines.push("ClawHub skipped");
  } else {
    assertSelectedPackagesResolved({
      label: "ClawHub plugin",
      selection: args.pluginSelection,
      packages: clawHubPlugins,
    });
    for (const plugin of clawHubPlugins) {
      await verifyClawHubPackage({
        registry: args.registry,
        packageName: plugin.packageName,
        version: args.version,
        distTag: args.distTag,
      });
    }
    lines.push(`ClawHub OK: ${clawHubPlugins.length}`);
  }

  const workflowRuns: WorkflowRunSummary[] = [];
  const allowedReleaseWorkflowHeadBranches = args.workflowRef
    ? ["main", args.workflowRef]
    : ["main"];
  if (args.workflowRuns.fullReleaseValidation !== undefined) {
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.fullReleaseValidation,
        label: "Full Release Validation",
        repo: args.repo,
        expectedWorkflowName: "Full Release Validation",
        allowedHeadBranches: allowedReleaseWorkflowHeadBranches,
        rerunFailed: false,
      }),
    );
  }
  if (args.workflowRuns.pluginNpm !== undefined) {
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.pluginNpm,
        label: "Plugin NPM Release",
        repo: args.repo,
        expectedWorkflowName: "Plugin NPM Release",
        expectedHeadBranch: args.workflowRef,
        rerunFailed: false,
      }),
    );
  }
  if (args.workflowRuns.pluginClawHub !== undefined) {
    const clawHubWorkflowRef = args.clawHubWorkflowRef ?? args.workflowRef;
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.pluginClawHub,
        label: "Plugin ClawHub Release",
        repo: args.repo,
        expectedWorkflowName: "Plugin ClawHub Release",
        expectedHeadBranch: clawHubWorkflowRef,
        rerunFailed: args.rerunFailedClawHub,
      }),
    );
  }
  if (args.workflowRuns.pluginClawHubBootstrap !== undefined) {
    workflowRuns.push(
      await verifyClawHubBootstrapRun({
        repo: args.repo,
        runId: args.workflowRuns.pluginClawHubBootstrap,
        releaseSha: requireCommitSha(args.releaseSha, "release SHA"),
        version: args.version,
        expectedPackages: args.clawHubBootstrapPlugins,
      }),
    );
  }
  if (args.workflowRuns.openclawNpm !== undefined) {
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.openclawNpm,
        label: "OpenClaw NPM Release",
        repo: args.repo,
        expectedWorkflowName: "OpenClaw NPM Release",
        expectedHeadBranch: args.workflowRef,
        rerunFailed: false,
      }),
    );
  }
  if (args.workflowRuns.npmTelegram !== undefined) {
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.npmTelegram,
        label: "NPM Telegram Beta E2E",
        repo: args.repo,
        expectedWorkflowName: "NPM Telegram Beta E2E",
        allowedHeadBranches: allowedReleaseWorkflowHeadBranches,
        rerunFailed: false,
      }),
    );
  }
  for (const run of workflowRuns) {
    lines.push(
      `${run.label} OK: ${run.id} (${formatDuration(run.durationSeconds)})${run.url ? ` ${run.url}` : ""}`,
    );
  }

  if (args.evidenceOut !== undefined) {
    const evidencePath = resolve(rootDir, args.evidenceOut);
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          version: 1,
          releaseVersion: args.version,
          releaseTag: args.tag,
          npmDistTag: args.distTag,
          pluginSelection: args.pluginSelection,
          openclawNpmIntegrity: openclawNpm.integrity,
          openclawNpmTarball: openclawNpm.tarball,
          npmRegistrySignaturesVerified: args.skipPostpublish ? null : true,
          npmProvenanceAttestationMatched: args.skipPostpublish ? null : true,
          githubReleaseUrl: releaseUrl ?? null,
          pluginNpmPackageCount: npmPlugins.length,
          clawHubPackageCount: clawHubPlugins.length,
          workflowRuns,
          clawHubBootstrapEvidence:
            workflowRuns.find((run) => run.bootstrapEvidence)?.bootstrapEvidence ?? null,
        },
        null,
        2,
      )}\n`,
    );
    lines.push(`release evidence written: ${args.evidenceOut}`);
  }

  return lines;
}

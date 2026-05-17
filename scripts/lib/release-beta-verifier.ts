import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectClawHubPublishablePluginPackages } from "./plugin-clawhub-release.ts";
import {
  collectPublishablePluginPackages,
  parsePluginReleaseSelection,
} from "./plugin-npm-release.ts";

type JsonRecord = Record<string, unknown>;

export type ReleaseVerifyBetaArgs = {
  version: string;
  tag: string;
  distTag: string;
  repo: string;
  registry: string;
  workflowRef?: string;
  pluginSelection: string[];
  evidenceOut?: string;
  skipPostpublish: boolean;
  rerunFailedClawHub: boolean;
  workflowRuns: {
    fullReleaseValidation?: string;
    openclawNpm?: string;
    pluginNpm?: string;
    pluginClawHub?: string;
    npmTelegram?: string;
  };
};

export type NpmViewFields = {
  version?: string;
  distTagVersion?: string;
  integrity?: string;
};

type WorkflowRunSummary = {
  id: string;
  label: string;
  url?: string;
  durationSeconds?: number;
};

const DEFAULT_REPO = "openclaw/openclaw";
const DEFAULT_CLAWHUB_REGISTRY = "https://clawhub.ai";

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
      "Usage: pnpm release:verify-beta -- <version> [--workflow-ref REF] [--full-release-validation-run ID] [--openclaw-npm-run ID] [--plugin-npm-run ID] [--plugin-clawhub-run ID] [--npm-telegram-run ID]",
    );
  }

  const parsed: ReleaseVerifyBetaArgs = {
    version,
    tag: `v${version}`,
    distTag: "beta",
    repo: DEFAULT_REPO,
    registry: DEFAULT_CLAWHUB_REGISTRY,
    workflowRef: undefined,
    pluginSelection: [],
    evidenceOut: undefined,
    skipPostpublish: false,
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
      case "--workflow-ref":
        parsed.workflowRef = next();
        break;
      case "--plugins":
        parsed.pluginSelection = parsePluginReleaseSelection(next());
        if (parsed.pluginSelection.length === 0) {
          throw new Error("--plugins requires at least one plugin package name.");
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
      case "--npm-telegram-run":
        parsed.workflowRuns.npmTelegram = next();
        break;
      case "--skip-postpublish":
        parsed.skipPostpublish = true;
        break;
      case "--rerun-failed-clawhub":
        parsed.rerunFailedClawHub = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempts: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 429 && response.status < 500) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1000));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${url} did not return a stable response: ${message}`);
}

async function fetchJsonWithRetry(url: string): Promise<unknown> {
  const response = await fetchWithRetry(url, { headers: { accept: "application/json" } }, 5);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
}

async function fetchStatusWithRetry(url: string, method: "GET" | "HEAD"): Promise<number> {
  const response = await fetchWithRetry(url, { method, redirect: "manual" }, 5);
  return response.status;
}

function verifyNpmPackage(packageName: string, version: string, distTag: string): NpmViewFields {
  const raw = runCommand("npm", [
    "view",
    `${packageName}@${version}`,
    "version",
    `dist-tags.${distTag}`,
    "dist.integrity",
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
  if (params.expectedHeadBranch !== undefined && headBranch !== params.expectedHeadBranch) {
    throw new Error(
      `${params.label}: run ${params.id} branch is ${headBranch ?? "<missing>"}, expected ${params.expectedHeadBranch}.`,
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

  const lines: string[] = [];
  const releaseUrl = verifyGitHubRelease(args);
  lines.push(`GitHub release OK: ${releaseUrl}`);

  const openclawNpm = verifyNpmPackage("openclaw", args.version, args.distTag);
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
    verifyNpmPackage(plugin.packageName, args.version, args.distTag);
  }
  lines.push(`plugin npm OK: ${npmPlugins.length}`);

  const clawHubPlugins = collectClawHubPublishablePluginPackages(rootDir, {
    packageNames: args.pluginSelection.length > 0 ? args.pluginSelection : undefined,
  });
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

  const workflowRuns: WorkflowRunSummary[] = [];
  if (args.workflowRuns.fullReleaseValidation !== undefined) {
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.fullReleaseValidation,
        label: "Full Release Validation",
        repo: args.repo,
        expectedWorkflowName: "Full Release Validation",
        expectedHeadBranch: args.workflowRef,
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
    workflowRuns.push(
      verifyWorkflowRun({
        id: args.workflowRuns.pluginClawHub,
        label: "Plugin ClawHub Release",
        repo: args.repo,
        expectedWorkflowName: "Plugin ClawHub Release",
        expectedHeadBranch: args.workflowRef,
        rerunFailed: args.rerunFailedClawHub,
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
        expectedHeadBranch: args.workflowRef,
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
          githubReleaseUrl: releaseUrl,
          pluginNpmPackageCount: npmPlugins.length,
          clawHubPackageCount: clawHubPlugins.length,
          workflowRuns,
        },
        null,
        2,
      )}\n`,
    );
    lines.push(`release evidence written: ${args.evidenceOut}`);
  }

  return lines;
}

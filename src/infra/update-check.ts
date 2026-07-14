// Computes git, dependency, and registry update status for OpenClaw installs.
import fs from "node:fs/promises";
import path from "node:path";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareValidSemver, normalizeLegacyDotBetaVersion } from "./semver.js";
import { channelToNpmTag, type UpdateChannel } from "./update-channels.js";

type PackageManager = "pnpm" | "bun" | "npm" | "unknown";

type GitUpdateStatus = {
  root: string;
  sha: string | null;
  tag: string | null;
  branch: string | null;
  upstream: string | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  fetchOk: boolean | null;
  error?: string;
};

type DepsStatus = {
  manager: PackageManager;
  status: "ok" | "missing" | "stale" | "unknown";
  lockfilePath: string | null;
  markerPath: string | null;
  reason?: string;
};

type RegistryStatus = {
  latestVersion: string | null;
  tag?: string;
  error?: string;
  reason?: ExtendedStableFailureReason;
};

export type ExtendedStableFailureReason =
  | "selector_missing"
  | "selector_query_failed"
  | "exact_package_mismatch"
  | "unsupported_git_channel";

type ExtendedStableResolutionResult =
  | {
      status: "resolved";
      selector: "extended-stable";
      version: string;
      packageSpec: string;
    }
  | {
      status: "failed";
      reason: ExtendedStableFailureReason;
    };

type NpmTagStatus = {
  tag: string;
  version: string | null;
  error?: string;
};

type NpmPackageTargetStatus = {
  target: string;
  version: string | null;
  nodeEngine: string | null;
  error?: string;
};

export type UpdateCheckResult = {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  packageManager: PackageManager;
  git?: GitUpdateStatus;
  deps?: DepsStatus;
  registry?: RegistryStatus;
};

type NpmMetadataCommandRunner = (
  argv: string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}>;

function toOptionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseNpmPackageTargetMetadata(raw: string): {
  version: string | null;
  nodeEngine: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch (err) {
    throw new Error(`npm view returned invalid JSON: ${String(err)}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { version: null, nodeEngine: null };
  }
  const rec = parsed as Record<string, unknown>;
  const engines = rec.engines && typeof rec.engines === "object" ? rec.engines : null;
  const nodeEngine =
    toOptionalTrimmedString(rec["engines.node"]) ??
    (engines ? toOptionalTrimmedString((engines as Record<string, unknown>).node) : null);
  return {
    version: toOptionalTrimmedString(rec.version),
    nodeEngine,
  };
}

function formatNpmViewError(res: { stdout: string; stderr: string }): string {
  const raw = (res.stderr.trim() || res.stdout.trim()).split("\n").slice(-3).join("\n");
  return raw ? `npm view failed: ${raw}` : "npm view failed";
}

function packageTargetSpec(params: { target: string; spec?: string }): string {
  const spec = params.spec?.trim();
  return spec || `openclaw@${params.target.trim() || "latest"}`;
}

const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const PUBLIC_NPM_PACKAGE_NAME = "openclaw";

function isLoopbackNpmRegistry(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function resolveExtendedStableRegistryTarget(params: {
  packageName?: string;
  env?: NodeJS.ProcessEnv;
}): { registryUrl: string; packageName: string } {
  const env = params.env ?? process.env;
  const packageName = params.packageName?.trim() || PUBLIC_NPM_PACKAGE_NAME;
  const packageSpecOverride = env.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim();
  const registryOverride = env.NPM_CONFIG_REGISTRY?.trim() || env.npm_config_registry?.trim() || "";

  // A matching package override plus a loopback registry is the explicit local
  // integration-test seam. Production resolution remains pinned to public npm.
  if (packageSpecOverride === packageName && isLoopbackNpmRegistry(registryOverride)) {
    return { registryUrl: registryOverride, packageName };
  }
  return {
    registryUrl: PUBLIC_NPM_REGISTRY_URL,
    packageName: PUBLIC_NPM_PACKAGE_NAME,
  };
}

function npmRegistryTargetUrl(params: {
  registryUrl: string;
  packageName: string;
  target: string;
}): string {
  const baseUrl = params.registryUrl.endsWith("/") ? params.registryUrl : `${params.registryUrl}/`;
  return new URL(
    `${encodeURIComponent(params.packageName)}/${encodeURIComponent(params.target)}`,
    baseUrl,
  ).toString();
}

async function fetchNpmPackageTargetStatusFromRegistry(params: {
  target: string;
  timeoutMs: number;
  registryUrl?: string;
  packageName?: string;
}): Promise<NpmPackageTargetStatus> {
  let res: Response | undefined;
  try {
    res = await fetchWithTimeout(
      npmRegistryTargetUrl({
        registryUrl: params.registryUrl ?? PUBLIC_NPM_REGISTRY_URL,
        packageName: params.packageName ?? PUBLIC_NPM_PACKAGE_NAME,
        target: params.target,
      }),
      {},
      Math.max(250, params.timeoutMs),
    );
    if (!res.ok) {
      return {
        target: params.target,
        version: null,
        nodeEngine: null,
        error: `HTTP ${res.status}`,
      };
    }
    const json = await readProviderJsonResponse<{
      version?: unknown;
      engines?: { node?: unknown };
    }>(res, "npm package target status");
    return {
      target: params.target,
      version: toOptionalTrimmedString(json.version),
      nodeEngine: toOptionalTrimmedString(json.engines?.node),
    };
  } catch (err) {
    return { target: params.target, version: null, nodeEngine: null, error: String(err) };
  } finally {
    if (res?.bodyUsed !== true) {
      await res?.body?.cancel().catch(() => undefined);
    }
  }
}

/** Resolves the extended-stable selector and verifies its exact package manifest. */
export async function resolveExtendedStablePackage(params: {
  installKind: "git" | "package" | "unknown";
  timeoutMs?: number;
  packageName?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ExtendedStableResolutionResult> {
  if (params.installKind === "git") {
    return { status: "failed", reason: "unsupported_git_channel" };
  }

  const timeoutMs = params.timeoutMs ?? 3500;
  const registryTarget = resolveExtendedStableRegistryTarget(params);
  const selector = await fetchNpmPackageTargetStatusFromRegistry({
    target: "extended-stable",
    timeoutMs,
    ...registryTarget,
  });
  if (!selector.version) {
    return {
      status: "failed",
      reason: selector.error === "HTTP 404" ? "selector_missing" : "selector_query_failed",
    };
  }

  const exact = await fetchNpmPackageTargetStatusFromRegistry({
    target: selector.version,
    timeoutMs,
    ...registryTarget,
  });
  if (exact.version !== selector.version) {
    return { status: "failed", reason: "exact_package_mismatch" };
  }

  return {
    status: "resolved",
    selector: "extended-stable",
    version: selector.version,
    packageSpec: `${registryTarget.packageName}@${selector.version}`,
  };
}

export function formatGitInstallLabel(update: UpdateCheckResult): string | null {
  if (update.installKind !== "git") {
    return null;
  }
  const shortSha = update.git?.sha ? update.git.sha.slice(0, 8) : null;
  const branch = update.git?.branch && update.git.branch !== "HEAD" ? update.git.branch : null;
  const tag = update.git?.tag ?? null;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  return (await detectPackageManagerImpl(root)) ?? "unknown";
}

async function detectGitRoot(root: string): Promise<string | null> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 4000,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const top = res.stdout.trim();
  return top ? path.resolve(top) : null;
}

async function checkGitUpdateStatus(params: {
  root: string;
  timeoutMs?: number;
  fetch?: boolean;
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = path.resolve(params.root);

  const base: GitUpdateStatus = {
    root,
    sha: null,
    tag: null,
    branch: null,
    upstream: null,
    dirty: null,
    ahead: null,
    behind: null,
    fetchOk: null,
  };

  const [branchRes, shaRes, tagRes, upstreamRes, dirtyRes] = await Promise.all([
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "describe", "--tags", "--exact-match"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(
      ["git", "-C", root, "status", "--porcelain", "--", ":!dist/control-ui/"],
      {
        timeoutMs,
      },
    ).catch(() => null),
  ]);
  if (!branchRes || branchRes.code !== 0) {
    return { ...base, error: branchRes?.stderr?.trim() || "git unavailable" };
  }
  const branch = branchRes.stdout.trim() || null;

  const sha = shaRes && shaRes.code === 0 ? shaRes.stdout.trim() : null;

  const tag = tagRes && tagRes.code === 0 ? tagRes.stdout.trim() : null;

  const upstream = upstreamRes && upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;

  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchOk = params.fetch
    ? await runCommandWithTimeout(["git", "-C", root, "fetch", "--quiet", "--prune"], { timeoutMs })
        .then((r) => r.code === 0)
        .catch(() => false)
    : null;

  const counts =
    upstream && upstream.length > 0
      ? await runCommandWithTimeout(
          ["git", "-C", root, "rev-list", "--left-right", "--count", `HEAD...${upstream}`],
          { timeoutMs },
        ).catch(() => null)
      : null;

  const parseCounts = (raw: string): { ahead: number; behind: number } | null => {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }
    const ahead = Number.parseInt(parts[0] ?? "", 10);
    const behind = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return null;
    }
    return { ahead, behind };
  };
  const parsed = counts && counts.code === 0 ? parseCounts(counts.stdout) : null;

  return {
    root,
    sha,
    tag,
    branch,
    upstream,
    dirty,
    ahead: parsed?.ahead ?? null,
    behind: parsed?.behind ?? null,
    fetchOk,
  };
}

async function statMtimeMs(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function resolveDepsMarker(params: { root: string; manager: PackageManager }): Promise<{
  lockfilePath: string | null;
  markerPath: string | null;
}> {
  const root = params.root;
  if (params.manager === "pnpm") {
    return {
      lockfilePath: path.join(root, "pnpm-lock.yaml"),
      markerPath: path.join(root, "node_modules", ".modules.yaml"),
    };
  }
  if (params.manager === "bun") {
    return {
      lockfilePath: path.join(root, "bun.lockb"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  if (params.manager === "npm") {
    const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json");
    return {
      lockfilePath: (await exists(shrinkwrapPath))
        ? shrinkwrapPath
        : path.join(root, "package-lock.json"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  return { lockfilePath: null, markerPath: null };
}

async function checkDepsStatus(params: {
  root: string;
  manager: PackageManager;
}): Promise<DepsStatus> {
  const root = path.resolve(params.root);
  const { lockfilePath, markerPath } = await resolveDepsMarker({
    root,
    manager: params.manager,
  });

  if (!lockfilePath || !markerPath) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
      reason: "unknown package manager",
    };
  }

  const lockExists = await exists(lockfilePath);
  const markerExists = await exists(markerPath);
  if (!lockExists) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
      reason: "lockfile missing",
    };
  }
  if (!markerExists) {
    return {
      manager: params.manager,
      status: "missing",
      lockfilePath,
      markerPath,
      reason: "node_modules marker missing",
    };
  }

  const lockMtime = await statMtimeMs(lockfilePath);
  const markerMtime = await statMtimeMs(markerPath);
  if (!lockMtime || !markerMtime) {
    return {
      manager: params.manager,
      status: "unknown",
      lockfilePath,
      markerPath,
    };
  }
  if (lockMtime > markerMtime + 1000) {
    return {
      manager: params.manager,
      status: "stale",
      lockfilePath,
      markerPath,
      reason: "lockfile newer than install marker",
    };
  }
  return {
    manager: params.manager,
    status: "ok",
    lockfilePath,
    markerPath,
  };
}

async function fetchNpmLatestVersion(params?: {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<RegistryStatus> {
  const res = await fetchNpmTagVersion({
    tag: "latest",
    timeoutMs: params?.timeoutMs,
    cwd: params?.cwd,
    env: params?.env,
    runCommand: params?.runCommand,
  });
  return {
    latestVersion: res.version,
    error: res.error,
  };
}

async function fetchNpmRegistryVersionForChannel(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<RegistryStatus> {
  const res = await resolveNpmChannelTag({
    channel: params.channel,
    timeoutMs: params.timeoutMs,
    cwd: params.cwd,
    env: params.env,
    runCommand: params.runCommand,
  });
  return {
    latestVersion: res.version,
    tag: res.tag,
    ...(res.reason ? { error: res.reason, reason: res.reason } : {}),
  };
}

export async function fetchNpmPackageTargetStatus(params: {
  target: string;
  timeoutMs?: number;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<NpmPackageTargetStatus> {
  const timeoutMs = params.timeoutMs ?? 3500;
  const target = params.target;
  if (!params.command && !params.runCommand) {
    return await fetchNpmPackageTargetStatusFromRegistry({ target, timeoutMs });
  }
  const runCommand = params.runCommand ?? runCommandWithTimeout;
  try {
    const res = await runCommand(
      [
        params.command ?? "npm",
        "view",
        packageTargetSpec({ target, spec: params.spec }),
        "version",
        "engines.node",
        "--json",
        "--global",
      ],
      {
        timeoutMs: Math.max(250, timeoutMs),
        cwd: params.cwd,
        env: params.env,
        maxOutputBytes: 1024 * 1024,
      },
    );
    if (res.code !== 0) {
      return {
        target,
        version: null,
        nodeEngine: null,
        error: formatNpmViewError(res),
      };
    }
    const { version, nodeEngine } = parseNpmPackageTargetMetadata(res.stdout);
    return { target, version, nodeEngine };
  } catch (err) {
    return { target, version: null, nodeEngine: null, error: String(err) };
  }
}

export async function fetchNpmTagVersion(params: {
  tag: string;
  timeoutMs?: number;
  spec?: string;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<NpmTagStatus> {
  const res = await fetchNpmPackageTargetStatus({
    target: params.tag,
    timeoutMs: params.timeoutMs,
    spec: params.spec,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    runCommand: params.runCommand,
  });
  return {
    tag: params.tag,
    version: res.version,
    error: res.error,
  };
}

export async function resolveNpmChannelTag(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: NpmMetadataCommandRunner;
}): Promise<{
  tag: string;
  version: string | null;
  reason?: ExtendedStableFailureReason;
}> {
  const channelTag = channelToNpmTag(params.channel);
  if (params.channel === "extended-stable") {
    const resolved = await resolveExtendedStablePackage({
      installKind: "package",
      timeoutMs: params.timeoutMs,
    });
    return resolved.status === "resolved"
      ? { tag: resolved.selector, version: resolved.version }
      : { tag: channelTag, version: null, reason: resolved.reason };
  }
  const channelStatus = await fetchNpmTagVersion({
    tag: channelTag,
    timeoutMs: params.timeoutMs,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    runCommand: params.runCommand,
  });
  if (params.channel !== "beta") {
    return { tag: channelTag, version: channelStatus.version };
  }

  const latestStatus = await fetchNpmTagVersion({
    tag: "latest",
    timeoutMs: params.timeoutMs,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    runCommand: params.runCommand,
  });
  if (!latestStatus.version) {
    return { tag: channelTag, version: channelStatus.version };
  }
  if (!channelStatus.version) {
    return { tag: "latest", version: latestStatus.version };
  }
  const cmp = compareSemverStrings(channelStatus.version, latestStatus.version);
  if (cmp != null && cmp < 0) {
    return { tag: "latest", version: latestStatus.version };
  }
  return { tag: channelTag, version: channelStatus.version };
}

export function compareSemverStrings(a: string | null, b: string | null): number | null {
  if (a && b) {
    const openClawReleaseCmp = compareOpenClawReleaseVersions(a, b);
    if (openClawReleaseCmp != null) {
      return openClawReleaseCmp;
    }
  }
  const normalizedA = a ? normalizeLegacyDotBetaVersion(a) : null;
  const normalizedB = b ? normalizeLegacyDotBetaVersion(b) : null;
  return normalizedA && normalizedB ? compareValidSemver(normalizedA, normalizedB) : null;
}

export async function checkUpdateStatus(params: {
  root: string | null;
  timeoutMs?: number;
  fetchGit?: boolean;
  includeRegistry?: boolean;
  registryChannel?: UpdateChannel;
}): Promise<UpdateCheckResult> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const fetchRegistry = () =>
    params.registryChannel
      ? fetchNpmRegistryVersionForChannel({
          channel: params.registryChannel,
          timeoutMs,
        })
      : fetchNpmLatestVersion({ timeoutMs });
  const root = params.root ? path.resolve(params.root) : null;
  if (!root) {
    return {
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: params.includeRegistry ? await fetchRegistry() : undefined,
    };
  }

  const rootRealpath = await fs.realpath(root).catch(() => root);
  const [pm, gitRoot] = await Promise.all([detectPackageManager(root), detectGitRoot(root)]);
  const isGit = gitRoot && path.resolve(gitRoot) === path.resolve(rootRealpath);

  const registry = params.includeRegistry
    ? params.registryChannel === "extended-stable" && isGit
      ? {
          latestVersion: null,
          tag: "extended-stable",
          error: "unsupported_git_channel",
          reason: "unsupported_git_channel" as const,
        }
      : await fetchRegistry()
    : undefined;

  const installKind: UpdateCheckResult["installKind"] = isGit ? "git" : "package";
  const [git, deps] = await Promise.all([
    isGit
      ? checkGitUpdateStatus({
          root,
          timeoutMs,
          fetch: Boolean(params.fetchGit),
        })
      : Promise.resolve(undefined),
    checkDepsStatus({ root, manager: pm }),
  ]);

  return {
    root,
    installKind,
    packageManager: pm,
    git,
    deps,
    registry,
  };
}

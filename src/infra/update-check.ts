// Computes git, dependency, and registry update status for OpenClaw installs.
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  detectPackageManager as detectPackageManagerImpl,
  isBunOwnedPackageRoot,
  isPnpmOwnedPackageRoot,
  resolvePnpmNodeModulesRoot,
} from "./detect-package-manager.js";
import { GIT_TIMEOUT_MS } from "./git-exec.js";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareValidSemver, normalizeLegacyDotBetaVersion } from "./semver.js";
import {
  channelToNpmTag,
  DEV_BRANCH,
  resolveDevUpstreamRefs,
  type UpdateChannel,
} from "./update-channels.js";
import {
  fetchNpmPackageTargetStatus,
  type NpmMetadataCommandRunner,
} from "./update-check-package-target.js";

type PackageManager = "pnpm" | "bun" | "npm" | "unknown";

type GitUpdateStatus = {
  root: string;
  sha: string | null;
  tag: string | null;
  branch: string | null;
  upstream: string | null;
  upstreamSource?: "tracking" | "receipt";
  upstreamSha?: string | null;
  commitAtMs?: number | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  fetchOk: boolean | null;
  error?: string;
};

type GitTrackingTarget = {
  revision: string;
  display: string;
  fetch: "prune" | { remote: string; mergeRef: string };
};

type DepsStatus = {
  manager: PackageManager;
  status: "ok" | "missing" | "unknown";
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

export type UpdateCheckResult = {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  packageManager: PackageManager;
  git?: GitUpdateStatus;
  deps?: DepsStatus;
  registry?: RegistryStatus;
};

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
  const selector = await fetchNpmPackageTargetStatus({
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

  const exact = await fetchNpmPackageTargetStatus({
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

// Packed manifests advertise the workspace pnpm packageManager, so installed roots need
// topology proof (pnpm virtual store, Bun global root, or otherwise npm); mistakes break self-update.
async function isLocklessOpenClawNpmInstall(params: {
  root: string;
  manager: PackageManager;
}): Promise<boolean> {
  if (params.manager !== "pnpm" || (await exists(path.join(params.root, "pnpm-lock.yaml")))) {
    return false;
  }
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(params.root, "package.json"), "utf8"));
    if (manifest?.name !== "openclaw") {
      return false;
    }
    if (
      !resolvePnpmNodeModulesRoot(params.root) ||
      (await isPnpmOwnedPackageRoot(params.root)) ||
      (await isBunOwnedPackageRoot(params.root))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
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
  timeoutMs: number | undefined;
  fetch?: boolean;
  useDetachedDevUpstream?: boolean;
  upstreamFallback?: { currentSha: string; upstreamRef: string };
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? (params.fetch ? GIT_TIMEOUT_MS : 6000);
  const root = path.resolve(params.root);
  const runGit = (...args: string[]) =>
    runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs }).catch(() => null);
  const readGit = async (...args: string[]) => {
    const result = await runGit(...args);
    return result?.code === 0 ? result.stdout.trim() || null : null;
  };

  const base: GitUpdateStatus = {
    root,
    sha: null,
    tag: null,
    branch: null,
    upstream: null,
    upstreamSha: null,
    commitAtMs: null,
    dirty: null,
    ahead: null,
    behind: null,
    fetchOk: null,
  };

  const [branchRes, sha, commitAtRaw, tag, dirtyRes] = await Promise.all([
    runGit("rev-parse", "--abbrev-ref", "HEAD"),
    readGit("rev-parse", "HEAD"),
    readGit("show", "-s", "--format=%ct", "HEAD"),
    readGit("describe", "--tags", "--exact-match"),
    runGit("status", "--porcelain", "--", ":!dist/control-ui/"),
  ]);
  if (!branchRes || branchRes.code !== 0) {
    return { ...base, error: branchRes?.stderr?.trim() || "git unavailable" };
  }
  const branch = branchRes.stdout.trim() || null;
  const trackingRevisions =
    branch === "HEAD"
      ? params.useDetachedDevUpstream
        ? resolveDevUpstreamRefs(true, [`refs/remotes/origin/${DEV_BRANCH}`])
        : []
      : resolveDevUpstreamRefs(false);
  let tracking: GitTrackingTarget | null = null;
  for (const revision of trackingRevisions) {
    const display = await readGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", revision);
    if (!display) {
      continue;
    }
    let fetch: GitTrackingTarget["fetch"] = "prune";
    if (branch === "HEAD") {
      if (revision === `${DEV_BRANCH}@{upstream}`) {
        const [remote, mergeRef] = await Promise.all([
          readGit("config", "--get", `branch.${DEV_BRANCH}.remote`),
          readGit("config", "--get", `branch.${DEV_BRANCH}.merge`),
        ]);
        if (!remote || !mergeRef) {
          continue;
        }
        fetch = { remote, mergeRef };
      } else {
        fetch = { remote: "origin", mergeRef: `refs/heads/${DEV_BRANCH}` };
      }
    }
    tracking = { revision, display, fetch };
    break;
  }

  const commitAtSeconds = Number.parseInt(commitAtRaw ?? "", 10);
  const commitAtMs = Number.isSafeInteger(commitAtSeconds) ? commitAtSeconds * 1000 : null;

  const receiptUpstream =
    !tracking &&
    branch === "HEAD" &&
    sha &&
    params.upstreamFallback?.currentSha.trim().toLowerCase() === sha.toLowerCase()
      ? params.upstreamFallback.upstreamRef.trim() || null
      : null;
  const upstream = tracking?.display ?? receiptUpstream;
  const upstreamSource = tracking
    ? ("tracking" as const)
    : receiptUpstream
      ? ("receipt" as const)
      : undefined;

  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchTarget =
    tracking?.fetch && tracking.fetch !== "prune"
      ? [
          "--",
          tracking.fetch.remote,
          `+${tracking.fetch.mergeRef}:refs/remotes/${tracking.display}`,
        ]
      : ["--prune"];
  const fetchOk = params.fetch
    ? (await runGit("fetch", "--quiet", ...fetchTarget))?.code === 0
    : null;

  // Freeze the post-fetch upstream for both graph queries. Active tracking wins;
  // a matching successful update receipt keeps intentional detached installs comparable.
  const upstreamRevision = `${upstreamSource === "tracking" ? tracking?.revision : upstream}^{commit}`;
  const upstreamCommit =
    (!params.fetch || fetchOk === true) && upstream && sha
      ? await readGit("rev-parse", "--verify", upstreamRevision)
      : null;
  const mergeBase = sha && upstreamCommit ? await readGit("merge-base", sha, upstreamCommit) : null;
  const counts =
    sha && upstreamCommit && mergeBase
      ? await readGit("rev-list", "--left-right", "--count", `${sha}...${upstreamCommit}`)
      : null;

  const parsed = counts?.match(/^(\d+)\s+(\d+)$/u);

  return {
    root,
    sha,
    tag,
    branch,
    upstream,
    ...(upstreamSource ? { upstreamSource } : {}),
    upstreamSha: upstreamCommit,
    commitAtMs,
    dirty,
    ahead: parsed ? Number(parsed[1]) : null,
    behind: parsed ? Number(parsed[2]) : null,
    fetchOk,
  };
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
    const textLockfilePath = path.join(root, "bun.lock");
    return {
      lockfilePath: (await exists(textLockfilePath))
        ? textLockfilePath
        : path.join(root, "bun.lockb"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  if (params.manager === "npm") {
    return {
      lockfilePath: path.join(root, "package-lock.json"),
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
  useDetachedDevUpstream?: boolean;
  gitUpstreamFallback?: { currentSha: string; upstreamRef: string };
  includeRegistry?: boolean;
  registryChannel?: UpdateChannel;
  resolveRegistryChannel?: (
    status: Pick<UpdateCheckResult, "installKind" | "git">,
  ) => UpdateChannel;
}): Promise<UpdateCheckResult> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const resolveRegistryChannel = (status: Pick<UpdateCheckResult, "installKind" | "git">) =>
    params.registryChannel ?? params.resolveRegistryChannel?.(status);
  const fetchRegistry = (registryChannel: UpdateChannel | undefined) =>
    registryChannel
      ? fetchNpmRegistryVersionForChannel({
          channel: registryChannel,
          timeoutMs,
        })
      : fetchNpmLatestVersion({ timeoutMs });
  const root = params.root ? path.resolve(params.root) : null;
  if (!root) {
    const registryChannel = resolveRegistryChannel({ installKind: "unknown" });
    return {
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: params.includeRegistry ? await fetchRegistry(registryChannel) : undefined,
    };
  }

  const rootRealpath = await fs.realpath(root).catch(() => root);
  const [detectedPackageManager, gitRoot] = await Promise.all([
    detectPackageManager(root),
    detectGitRoot(root),
  ]);
  const isGit = gitRoot && path.resolve(gitRoot) === path.resolve(rootRealpath);
  const packageManager =
    !isGit &&
    (await isLocklessOpenClawNpmInstall({
      root,
      manager: detectedPackageManager,
    }))
      ? "npm"
      : detectedPackageManager;

  const installKind: UpdateCheckResult["installKind"] = isGit ? "git" : "package";
  const [git, deps] = await Promise.all([
    isGit
      ? checkGitUpdateStatus({
          root,
          timeoutMs: params.timeoutMs,
          fetch: Boolean(params.fetchGit),
          useDetachedDevUpstream: params.useDetachedDevUpstream,
          upstreamFallback: params.gitUpstreamFallback,
        })
      : Promise.resolve(undefined),
    checkDepsStatus({ root, manager: packageManager }),
  ]);
  const registryChannel = resolveRegistryChannel({ installKind, git });
  const registry = params.includeRegistry
    ? registryChannel === "extended-stable" && isGit
      ? {
          latestVersion: null,
          tag: "extended-stable",
          error: "unsupported_git_channel",
          reason: "unsupported_git_channel" as const,
        }
      : await fetchRegistry(registryChannel)
    : undefined;

  return {
    root,
    installKind,
    packageManager,
    git,
    deps,
    registry,
  };
}

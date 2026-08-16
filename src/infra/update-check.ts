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
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareValidSemver, normalizeLegacyDotBetaVersion } from "./semver.js";
import { channelToNpmTag, DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
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
  timeoutMs?: number;
  fetch?: boolean;
  useDetachedDevUpstream?: boolean;
  upstreamFallback?: { currentSha: string; upstreamRef: string };
}): Promise<GitUpdateStatus> {
  const timeoutMs = params.timeoutMs ?? 6000;
  const root = path.resolve(params.root);

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

  const [branchRes, shaRes, commitAtRes, tagRes, dirtyRes] = await Promise.all([
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "rev-parse", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "show", "-s", "--format=%ct", "HEAD"], {
      timeoutMs,
    }).catch(() => null),
    runCommandWithTimeout(["git", "-C", root, "describe", "--tags", "--exact-match"], {
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
  const trackingRevision =
    branch === "HEAD"
      ? params.useDetachedDevUpstream
        ? `refs/remotes/origin/${DEV_BRANCH}`
        : null
      : "@{upstream}";
  const upstreamRes = trackingRevision
    ? await runCommandWithTimeout(
        ["git", "-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", trackingRevision],
        { timeoutMs },
      ).catch(() => null)
    : null;

  const sha = shaRes && shaRes.code === 0 ? shaRes.stdout.trim() : null;
  const commitAtSeconds =
    commitAtRes?.code === 0 ? Number.parseInt(commitAtRes.stdout.trim(), 10) : Number.NaN;
  const commitAtMs = Number.isSafeInteger(commitAtSeconds) ? commitAtSeconds * 1000 : null;

  const tag = tagRes && tagRes.code === 0 ? tagRes.stdout.trim() : null;

  const trackingUpstream =
    upstreamRes && upstreamRes.code === 0 ? upstreamRes.stdout.trim() || null : null;
  const receiptUpstream =
    !trackingUpstream &&
    branch === "HEAD" &&
    sha &&
    params.upstreamFallback?.currentSha.trim().toLowerCase() === sha.toLowerCase()
      ? params.upstreamFallback.upstreamRef.trim() || null
      : null;
  const upstream = trackingUpstream ?? receiptUpstream;
  const upstreamSource = trackingUpstream
    ? ("tracking" as const)
    : receiptUpstream
      ? ("receipt" as const)
      : undefined;

  const dirty = dirtyRes && dirtyRes.code === 0 ? dirtyRes.stdout.trim().length > 0 : null;

  const fetchTarget =
    branch === "HEAD" && upstreamSource === "tracking"
      ? ["origin", `+refs/heads/${DEV_BRANCH}:refs/remotes/origin/${DEV_BRANCH}`]
      : ["--prune"];
  const fetchOk = params.fetch
    ? await runCommandWithTimeout(["git", "-C", root, "fetch", "--quiet", ...fetchTarget], {
        timeoutMs,
      })
        .then((r) => r.code === 0)
        .catch(() => false)
    : null;

  // Freeze the post-fetch upstream for both graph queries. Active tracking wins;
  // a matching successful update receipt keeps intentional detached installs comparable.
  const upstreamRevision = `${upstreamSource === "tracking" ? trackingRevision : upstream}^{commit}`;
  const upstreamCommitRes =
    (!params.fetch || fetchOk === true) && upstream && sha
      ? await runCommandWithTimeout(
          ["git", "-C", root, "rev-parse", "--verify", upstreamRevision],
          { timeoutMs },
        ).catch(() => null)
      : null;
  const upstreamCommit =
    upstreamCommitRes?.code === 0 ? upstreamCommitRes.stdout.trim() || null : null;
  const mergeBase =
    sha && upstreamCommit
      ? await runCommandWithTimeout(["git", "-C", root, "merge-base", sha, upstreamCommit], {
          timeoutMs,
        }).catch(() => null)
      : null;
  const counts =
    sha && upstreamCommit && mergeBase?.code === 0 && mergeBase.stdout.trim().length > 0
      ? await runCommandWithTimeout(
          ["git", "-C", root, "rev-list", "--left-right", "--count", `${sha}...${upstreamCommit}`],
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
    ...(upstreamSource ? { upstreamSource } : {}),
    upstreamSha: upstreamCommit,
    commitAtMs,
    dirty,
    ahead: parsed?.ahead ?? null,
    behind: parsed?.behind ?? null,
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
          timeoutMs,
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

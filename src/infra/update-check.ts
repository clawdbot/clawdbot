import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareComparableSemver, parseComparableSemver } from "./semver-compare.js";
import { channelToNpmTag, type UpdateChannel } from "./update-channels.js";

export type PackageManager = "pnpm" | "bun" | "npm" | "unknown";

export type GitUpdateStatus = {
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

export type DepsStatus = {
  manager: PackageManager;
  status: "ok" | "missing" | "stale" | "unknown";
  lockfilePath: string | null;
  markerPath: string | null;
  reason?: string;
};

export type RegistryStatus = {
  latestVersion: string | null;
  tag?: string;
  error?: string;
};

export type NpmTagStatus = {
  tag: string;
  version: string | null;
  error?: string;
};

export type NpmPackageTargetStatus = {
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

export async function checkGitUpdateStatus(params: {
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

function resolveDepsMarker(params: { root: string; manager: PackageManager }): {
  lockfilePath: string | null;
  markerPath: string | null;
} {
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
    return {
      lockfilePath: path.join(root, "package-lock.json"),
      markerPath: path.join(root, "node_modules"),
    };
  }
  return { lockfilePath: null, markerPath: null };
}

export async function checkDepsStatus(params: {
  root: string;
  manager: PackageManager;
}): Promise<DepsStatus> {
  const root = path.resolve(params.root);
  const { lockfilePath, markerPath } = resolveDepsMarker({
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

export async function fetchNpmLatestVersion(params?: {
  timeoutMs?: number;
}): Promise<RegistryStatus> {
  const res = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params?.timeoutMs });
  return {
    latestVersion: res.version,
    error: res.error,
  };
}

export async function fetchNpmRegistryVersionForChannel(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<RegistryStatus> {
  const res = await resolveNpmChannelTag({
    channel: params.channel,
    timeoutMs: params.timeoutMs,
  });
  return {
    latestVersion: res.version,
    tag: res.tag,
  };
}

export async function fetchNpmPackageTargetStatus(params: {
  target: string;
  timeoutMs?: number;
}): Promise<NpmPackageTargetStatus> {
  const timeoutMs = params.timeoutMs ?? 3500;
  const target = params.target;
  try {
    const res = await fetchWithTimeout(
      `https://registry.npmjs.org/openclaw/${encodeURIComponent(target)}`,
      {},
      Math.max(250, timeoutMs),
    );
    if (!res.ok) {
      return { target, version: null, nodeEngine: null, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      version?: unknown;
      engines?: { node?: unknown };
    };
    const version = typeof json?.version === "string" ? json.version : null;
    const nodeEngine = typeof json?.engines?.node === "string" ? json.engines.node : null;
    return { target, version, nodeEngine };
  } catch (err) {
    return { target, version: null, nodeEngine: null, error: String(err) };
  }
}

export async function fetchNpmTagVersion(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<NpmTagStatus> {
  const res = await fetchNpmPackageTargetStatus({
    target: params.tag,
    timeoutMs: params.timeoutMs,
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
}): Promise<{ tag: string; version: string | null }> {
  const channelTag = channelToNpmTag(params.channel);
  const channelStatus = await fetchNpmTagVersion({ tag: channelTag, timeoutMs: params.timeoutMs });
  if (params.channel !== "beta") {
    return { tag: channelTag, version: channelStatus.version };
  }

  const latestStatus = await fetchNpmTagVersion({ tag: "latest", timeoutMs: params.timeoutMs });
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
  return compareComparableSemver(
    parseComparableSemver(a, { normalizeLegacyDotBeta: true }),
    parseComparableSemver(b, { normalizeLegacyDotBeta: true }),
  );
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
  const [pm, gitRoot, registry] = await Promise.all([
    detectPackageManager(root),
    detectGitRoot(root),
    params.includeRegistry ? fetchRegistry() : Promise.resolve(undefined),
  ]);
  const isGit = gitRoot && path.resolve(gitRoot) === path.resolve(rootRealpath);

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

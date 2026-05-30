import fsSync from "node:fs";
import path from "node:path";
import {
  downloadClawHubSkillArchive,
  fetchClawHubSkillDetail,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
  type ClawHubSkillDetail,
  type ClawHubSkillSearchResult,
} from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { readJsonIfExists, tryReadJson, writeJson } from "../../infra/json-files.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
  normalizeTrackedSkillSlug,
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "./archive-install.js";

const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const SKILL_ORIGIN_RELATIVE_PATH = path.join(DOT_DIR, "origin.json");
const LOCAL_SKILL_CARD_FILENAME = "skill-card.md";
const LOCAL_SKILL_CARD_MAX_BYTES = 256 * 1024;

export type ClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

export type ClawHubSkillsLockfile = {
  version: 1;
  skills: Record<
    string,
    {
      version: string;
      installedAt: number;
      registry?: string;
    }
  >;
};

export type ClawHubSkillsLockfileStatusRead =
  | { kind: "found"; lock: ClawHubSkillsLockfile; path: string }
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string };

export type ClawHubSkillStatusLink =
  | {
      status: "linked";
      valid: true;
      registry: string;
      slug: string;
      installedVersion: string;
      installedAt: number;
      originPath: string;
      lockPath: string;
    }
  | {
      status: "invalid";
      valid: false;
      reason: string;
      registry?: string;
      slug?: string;
      installedVersion?: string;
      installedAt?: number;
      originPath?: string;
      lockPath?: string;
    };

export type LocalSkillCardStatus = {
  present: true;
  path: string;
  sizeBytes: number;
};

type LocalSkillCardRead = LocalSkillCardStatus & {
  content?: string;
};

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail: ClawHubSkillDetail;
    }
  | { ok: false; error: string };

export type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
    }
  | { ok: false; error: string };

type Logger = {
  info?: (message: string) => void;
};

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const trackedSlug = normalizeTrackedSkillSlug(params.requestedSlug);
  const trackedTargetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
  const trackedOrigin = await readClawHubSkillOrigin(trackedTargetDir);
  if (trackedOrigin || params.lock.skills[trackedSlug]) {
    return trackedSlug;
  }
  return validateRequestedSkillSlug(params.requestedSlug);
}

type ClawHubInstallParams = {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
};

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      baseUrl?: string;
      previousVersion: string | null;
    }
  | {
      ok: false;
      slug: string;
      error: string;
    };

export type ClawHubSkillVerificationResolutionSource = "installed" | "registry";
export type ClawHubSkillVerificationSelector = "installed-version" | "version" | "tag" | "latest";

export type ClawHubSkillVerificationTargetResult =
  | {
      ok: true;
      slug: string;
      baseUrl: string;
      version: string | undefined;
      tag: string | undefined;
      resolution: {
        source: ClawHubSkillVerificationResolutionSource;
        selector: ClawHubSkillVerificationSelector;
        registry: string;
        skillDir: string | undefined;
        installedVersion: string | undefined;
      };
    }
  | {
      ok: false;
      error: string;
    };

export async function readClawHubSkillsLockfile(
  workspaceDir: string,
): Promise<ClawHubSkillsLockfile> {
  const candidates = [
    path.join(workspaceDir, DOT_DIR, "lock.json"),
    path.join(workspaceDir, LEGACY_DOT_DIR, "lock.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await tryReadJson<Partial<ClawHubSkillsLockfile>>(candidate);
      if (raw?.version === 1 && raw.skills && typeof raw.skills === "object") {
        return {
          version: 1,
          skills: raw.skills,
        };
      }
    } catch {
      // ignore
    }
  }
  return { version: 1, skills: {} };
}

async function writeClawHubSkillsLockfile(
  workspaceDir: string,
  lockfile: ClawHubSkillsLockfile,
): Promise<void> {
  const targetPath = path.join(workspaceDir, DOT_DIR, "lock.json");
  await writeJson(targetPath, lockfile, { trailingNewline: true });
}

function readJsonIfExistsSync(
  candidate: string,
): { exists: false } | { exists: true; value: unknown } {
  try {
    return { exists: true, value: JSON.parse(fsSync.readFileSync(candidate, "utf8")) };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

function normalizeStoredRegistry(registry: string): string {
  const trimmed = registry.trim();
  return trimmed.replace(/\/+$/, "") || trimmed;
}

function readRealPathSync(candidate: string): string | undefined {
  try {
    return fsSync.realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

export function readClawHubSkillsLockfileStatusSync(
  workspaceDir: string,
): ClawHubSkillsLockfileStatusRead {
  const candidates = [
    path.join(workspaceDir, DOT_DIR, "lock.json"),
    path.join(workspaceDir, LEGACY_DOT_DIR, "lock.json"),
  ];
  for (const candidate of candidates) {
    let raw: Partial<ClawHubSkillsLockfile> | null;
    try {
      const read = readJsonIfExistsSync(candidate);
      if (!read.exists) {
        continue;
      }
      raw = read.value as Partial<ClawHubSkillsLockfile>;
    } catch (err) {
      return {
        kind: "malformed",
        path: candidate,
        error: formatErrorMessage(err),
      };
    }
    if (raw?.version === 1 && raw.skills && typeof raw.skills === "object") {
      return {
        kind: "found",
        path: candidate,
        lock: {
          version: 1,
          skills: raw.skills,
        },
      };
    }
    return {
      kind: "malformed",
      path: candidate,
      error: "expected version 1 lockfile with skills",
    };
  }
  return { kind: "missing" };
}

function normalizeOptionalSelector(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeClawHubSkillOrigin(
  raw: Partial<ClawHubSkillOrigin> | null,
): ClawHubSkillOrigin | null {
  if (
    raw?.version === 1 &&
    typeof raw.registry === "string" &&
    raw.registry.trim().length > 0 &&
    typeof raw.slug === "string" &&
    raw.slug.trim().length > 0 &&
    typeof raw.installedVersion === "string" &&
    raw.installedVersion.trim().length > 0 &&
    typeof raw.installedAt === "number"
  ) {
    return {
      version: 1,
      registry: normalizeStoredRegistry(raw.registry),
      slug: raw.slug,
      installedVersion: raw.installedVersion,
      installedAt: raw.installedAt,
    };
  }
  return null;
}

async function readClawHubSkillOrigin(skillDir: string): Promise<ClawHubSkillOrigin | null> {
  const candidates = [
    path.join(skillDir, DOT_DIR, "origin.json"),
    path.join(skillDir, LEGACY_DOT_DIR, "origin.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await tryReadJson<Partial<ClawHubSkillOrigin>>(candidate);
      const origin = normalizeClawHubSkillOrigin(raw);
      if (origin) {
        return origin;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function readClawHubSkillOriginStatusSync(skillDir: string): StrictOriginReadResult {
  const candidates = [
    path.join(skillDir, DOT_DIR, "origin.json"),
    path.join(skillDir, LEGACY_DOT_DIR, "origin.json"),
  ];
  for (const candidate of candidates) {
    let raw: Partial<ClawHubSkillOrigin> | null;
    try {
      const read = readJsonIfExistsSync(candidate);
      if (!read.exists) {
        continue;
      }
      raw = read.value as Partial<ClawHubSkillOrigin>;
    } catch (err) {
      return {
        kind: "malformed",
        path: candidate,
        error: formatErrorMessage(err),
      };
    }
    const origin = normalizeClawHubSkillOrigin(raw);
    if (origin) {
      return { kind: "found", origin, path: candidate };
    }
    return {
      kind: "malformed",
      path: candidate,
      error: "expected version 1 origin with registry, slug, installedVersion, and installedAt",
    };
  }
  return { kind: "missing" };
}

type StrictOriginReadResult =
  | { kind: "found"; origin: ClawHubSkillOrigin; path: string }
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string };

async function readClawHubSkillOriginStrict(skillDir: string): Promise<StrictOriginReadResult> {
  const candidates = [
    path.join(skillDir, DOT_DIR, "origin.json"),
    path.join(skillDir, LEGACY_DOT_DIR, "origin.json"),
  ];
  for (const candidate of candidates) {
    let raw: Partial<ClawHubSkillOrigin> | null;
    try {
      raw = await readJsonIfExists<Partial<ClawHubSkillOrigin>>(candidate);
    } catch (err) {
      return {
        kind: "malformed",
        path: candidate,
        error: formatErrorMessage(err),
      };
    }
    if (!raw) {
      continue;
    }
    const origin = normalizeClawHubSkillOrigin(raw);
    if (origin) {
      return { kind: "found", origin, path: candidate };
    }
    return {
      kind: "malformed",
      path: candidate,
      error: "expected version 1 origin with registry, slug, installedVersion, and installedAt",
    };
  }
  return { kind: "missing" };
}

export function resolveClawHubSkillStatusLinkSync(params: {
  workspaceDir: string;
  skillDir: string;
  skillKey: string;
  lockRead?: ClawHubSkillsLockfileStatusRead;
}): ClawHubSkillStatusLink | undefined {
  const originRead = readClawHubSkillOriginStatusSync(params.skillDir);
  const lockRead = params.lockRead ?? readClawHubSkillsLockfileStatusSync(params.workspaceDir);

  if (originRead.kind === "missing") {
    let trackedSlug: string;
    try {
      trackedSlug = normalizeTrackedSkillSlug(params.skillKey);
    } catch {
      return undefined;
    }
    const locked = lockRead.kind === "found" ? lockRead.lock.skills[trackedSlug] : undefined;
    if (!locked) {
      return undefined;
    }
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" is tracked by the workspace ClawHub lockfile but is missing local ClawHub origin metadata.`,
      slug: trackedSlug,
      installedVersion: locked.version,
      installedAt: locked.installedAt,
      registry: normalizeStoredRegistry(locked.registry ?? resolveClawHubBaseUrl()),
      lockPath: lockRead.kind === "found" ? lockRead.path : undefined,
    };
  }

  if (originRead.kind === "malformed") {
    return {
      status: "invalid",
      valid: false,
      reason: `Malformed ClawHub origin metadata at ${originRead.path}: ${originRead.error}`,
      originPath: originRead.path,
      lockPath: lockRead.kind === "found" ? lockRead.path : undefined,
    };
  }

  let trackedSlug: string;
  try {
    trackedSlug = normalizeTrackedSkillSlug(originRead.origin.slug);
  } catch (err) {
    return {
      status: "invalid",
      valid: false,
      reason: `Invalid ClawHub origin slug "${originRead.origin.slug}": ${formatErrorMessage(err)}`,
      registry: originRead.origin.registry,
      slug: originRead.origin.slug,
      installedVersion: originRead.origin.installedVersion,
      installedAt: originRead.origin.installedAt,
      originPath: originRead.path,
      lockPath: lockRead.kind === "found" ? lockRead.path : undefined,
    };
  }

  if (lockRead.kind === "missing") {
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the workspace ClawHub lockfile.`,
      registry: originRead.origin.registry,
      slug: trackedSlug,
      installedVersion: originRead.origin.installedVersion,
      installedAt: originRead.origin.installedAt,
      originPath: originRead.path,
    };
  }
  if (lockRead.kind === "malformed") {
    return {
      status: "invalid",
      valid: false,
      reason: `Malformed workspace ClawHub lockfile at ${lockRead.path}: ${lockRead.error}`,
      registry: originRead.origin.registry,
      slug: trackedSlug,
      installedVersion: originRead.origin.installedVersion,
      installedAt: originRead.origin.installedAt,
      originPath: originRead.path,
      lockPath: lockRead.path,
    };
  }
  const locked = lockRead.lock.skills[trackedSlug];
  if (!locked) {
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the workspace ClawHub lockfile.`,
      registry: originRead.origin.registry,
      slug: trackedSlug,
      installedVersion: originRead.origin.installedVersion,
      installedAt: originRead.origin.installedAt,
      originPath: originRead.path,
      lockPath: lockRead.path,
    };
  }
  const expectedSkillDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
  const expectedSkillDirRealPath = readRealPathSync(expectedSkillDir);
  const actualSkillDirRealPath = readRealPathSync(params.skillDir);
  if (!expectedSkillDirRealPath || actualSkillDirRealPath !== expectedSkillDirRealPath) {
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" ClawHub origin metadata is not in the expected ClawHub install directory.`,
      registry: originRead.origin.registry,
      slug: trackedSlug,
      installedVersion: originRead.origin.installedVersion,
      installedAt: originRead.origin.installedAt,
      originPath: originRead.path,
      lockPath: lockRead.path,
    };
  }
  const originRegistry = normalizeStoredRegistry(originRead.origin.registry);
  const lockedRegistry =
    locked.registry === undefined ? originRegistry : normalizeStoredRegistry(locked.registry);
  if (
    locked.version !== originRead.origin.installedVersion ||
    locked.installedAt !== originRead.origin.installedAt ||
    lockedRegistry !== originRegistry
  ) {
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" ClawHub origin metadata does not match the workspace ClawHub lockfile.`,
      registry: lockedRegistry,
      slug: trackedSlug,
      installedVersion: originRead.origin.installedVersion,
      installedAt: originRead.origin.installedAt,
      originPath: originRead.path,
      lockPath: lockRead.path,
    };
  }
  return {
    status: "linked",
    valid: true,
    registry: lockedRegistry,
    slug: trackedSlug,
    installedVersion: locked.version,
    installedAt: locked.installedAt,
    originPath: originRead.path,
    lockPath: lockRead.path,
  };
}

export function resolveLocalSkillCardStatusSync(
  skillDir: string,
): LocalSkillCardStatus | undefined {
  return readLocalSkillCardSync(skillDir);
}

function isPathInsideDir(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function readLocalSkillCardSync(
  skillDir: string,
  includeContent = false,
): LocalSkillCardRead | undefined {
  const cardPath = path.join(skillDir, LOCAL_SKILL_CARD_FILENAME);
  let lstat: fsSync.Stats;
  try {
    lstat = fsSync.lstatSync(cardPath);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
  if (!lstat.isFile() || lstat.size > LOCAL_SKILL_CARD_MAX_BYTES) {
    return undefined;
  }
  let fd: number | undefined;
  try {
    const rootRealPath = fsSync.realpathSync.native(skillDir);
    const cardRealPath = fsSync.realpathSync.native(cardPath);
    if (!isPathInsideDir(cardRealPath, rootRealPath)) {
      return undefined;
    }
    const noFollowFlag = fsSync.constants.O_NOFOLLOW ?? 0;
    fd = fsSync.openSync(cardPath, fsSync.constants.O_RDONLY | noFollowFlag);
    const fdStat = fsSync.fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size > LOCAL_SKILL_CARD_MAX_BYTES) {
      return undefined;
    }
    const result: LocalSkillCardRead = {
      present: true,
      path: cardPath,
      sizeBytes: fdStat.size,
    };
    if (includeContent) {
      result.content = fsSync.readFileSync(fd, "utf8");
    }
    return result;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // ignore close errors while reporting the card as unavailable
      }
    }
  }
}

export function readLocalSkillCardContentSync(skillDir: string): string | undefined {
  return readLocalSkillCardSync(skillDir, true)?.content;
}

async function writeClawHubSkillOrigin(
  skillDir: string,
  origin: ClawHubSkillOrigin,
): Promise<void> {
  const targetPath = path.join(skillDir, SKILL_ORIGIN_RELATIVE_PATH);
  await writeJson(targetPath, origin, { trailingNewline: true });
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  return await searchClawHubSkills({
    query: params.query?.trim() || "*",
    limit: params.limit,
    baseUrl: params.baseUrl,
  });
}

export async function resolveClawHubSkillVerificationTarget(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
}): Promise<ClawHubSkillVerificationTargetResult> {
  try {
    const version = normalizeOptionalSelector(params.version);
    const tag = normalizeOptionalSelector(params.tag);
    if (version && tag) {
      return { ok: false, error: "Use either --version or --tag." };
    }

    const trackedSlug = normalizeTrackedSkillSlug(params.slug);
    const skillDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
    const originRead = await readClawHubSkillOriginStrict(skillDir);
    if (originRead.kind === "malformed") {
      return {
        ok: false,
        error: `Malformed ClawHub origin metadata at ${originRead.path}: ${originRead.error}`,
      };
    }

    if (originRead.kind === "found") {
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      const locked = lock.skills[trackedSlug];
      if (!locked) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const originSlug = normalizeTrackedSkillSlug(originRead.origin.slug);
      if (originSlug !== trackedSlug) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" has ClawHub origin metadata for "${originRead.origin.slug}". Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const originRegistry = normalizeStoredRegistry(originRead.origin.registry);
      const lockedRegistry =
        locked.registry === undefined ? originRegistry : normalizeStoredRegistry(locked.registry);
      if (
        locked.version !== originRead.origin.installedVersion ||
        locked.installedAt !== originRead.origin.installedAt ||
        lockedRegistry !== originRegistry
      ) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" ClawHub origin metadata does not match the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      const selector: ClawHubSkillVerificationSelector = version
        ? "version"
        : tag
          ? "tag"
          : "installed-version";
      return {
        ok: true,
        slug: trackedSlug,
        baseUrl: lockedRegistry,
        version: version ?? (tag ? undefined : locked.version),
        tag,
        resolution: {
          source: "installed",
          selector,
          registry: lockedRegistry,
          skillDir,
          installedVersion: locked.version,
        },
      };
    }

    const lockRead = readClawHubSkillsLockfileStatusSync(params.workspaceDir);
    if (lockRead.kind === "malformed") {
      return {
        ok: false,
        error: `Malformed workspace ClawHub lockfile at ${lockRead.path}: ${lockRead.error}`,
      };
    }
    if (lockRead.kind === "found" && lockRead.lock.skills[trackedSlug]) {
      return {
        ok: false,
        error: `Skill "${trackedSlug}" is tracked by the workspace ClawHub lockfile but is missing ClawHub origin metadata. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
      };
    }

    const slug = validateRequestedSkillSlug(params.slug);
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const selector: ClawHubSkillVerificationSelector = version ? "version" : tag ? "tag" : "latest";
    return {
      ok: true,
      slug,
      baseUrl: registry,
      version,
      tag,
      resolution: {
        source: "registry",
        selector,
        registry,
        skillDir: undefined,
        installedVersion: undefined,
      },
    };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

async function resolveInstallVersion(params: {
  slug: string;
  version?: string;
  baseUrl?: string;
}): Promise<{ detail: ClawHubSkillDetail; version: string }> {
  const detail = await fetchClawHubSkillDetail({
    slug: params.slug,
    baseUrl: params.baseUrl,
  });
  if (!detail.skill) {
    throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
  }
  const resolvedVersion = params.version ?? detail.latestVersion?.version;
  if (!resolvedVersion) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  return {
    detail,
    version: resolvedVersion,
  };
}

async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const { detail, version } = await resolveInstallVersion({
      slug: params.slug,
      version: params.version,
      baseUrl: params.baseUrl,
    });
    const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    if (!params.force && (await pathExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
    const archive = await downloadClawHubSkillArchive({
      slug: params.slug,
      version,
      baseUrl: params.baseUrl,
    });
    try {
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-",
        timeoutMs: 120_000,
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        onExtracted: async (rootDir) =>
          await installExtractedSkillRoot({
            workspaceDir: params.workspaceDir,
            slug: params.slug,
            extractedRoot: rootDir,
            mode: params.force ? "update" : "install",
            logger: params.logger,
            scan: false,
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
          }),
      });
      if (!install.ok) {
        return { ok: false, error: install.error };
      }

      const installedAt = Date.now();
      await writeClawHubSkillOrigin(install.targetDir, {
        version: 1,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        slug: params.slug,
        installedVersion: version,
        installedAt,
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[params.slug] = {
        version,
        installedAt,
        registry: resolveClawHubBaseUrl(params.baseUrl),
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);

      return {
        ok: true,
        slug: params.slug,
        version,
        targetDir: install.targetDir,
        detail,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: validateRequestedSkillSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSkillSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  lock: ClawHubSkillsLockfile;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
  const origin = (await readClawHubSkillOrigin(targetDir)) ?? null;
  if (!origin && !params.lock.skills[params.slug]) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  return {
    ok: true,
    slug: params.slug,
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? params.lock.skills[params.slug]?.version ?? null,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  logger?: Logger;
}): Promise<InstallClawHubSkillResult> {
  return await installRequestedSkillFromClawHub(params);
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          lock,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSkillSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const tracked = await resolveTrackedUpdateTarget({
      workspaceDir: params.workspaceDir,
      slug,
      lock,
      baseUrl: params.baseUrl,
    });
    if (!tracked.ok) {
      results.push({
        ok: false,
        error: tracked.error,
      });
      continue;
    }
    const install = await installTrackedSkillFromClawHub({
      workspaceDir: params.workspaceDir,
      slug: tracked.slug,
      baseUrl: tracked.baseUrl,
      force: true,
      logger: params.logger,
    });
    if (!install.ok) {
      results.push(install);
      continue;
    }
    results.push({
      ok: true,
      slug: tracked.slug,
      previousVersion: tracked.previousVersion,
      version: install.version,
      changed: tracked.previousVersion !== install.version,
      targetDir: install.targetDir,
    });
  }
  return results;
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  return Object.keys(lock.skills).toSorted();
}

export async function untrackClawHubSkill(workspaceDir: string, slug: string): Promise<void> {
  const trackedSlug = normalizeTrackedSkillSlug(slug);
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  if (!lock.skills[trackedSlug]) {
    return;
  }
  delete lock.skills[trackedSlug];
  await writeClawHubSkillsLockfile(workspaceDir, lock);
}

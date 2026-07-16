// ClawHub lifecycle helpers fetch skill registry metadata and package details.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type ClawHubTrustErrorCode,
  ensureClawHubPackageTrustAcknowledged,
  type ClawHubRiskAcknowledgementRequest,
} from "../../infra/clawhub-install-trust.js";
import {
  downloadClawHubGitHubSkillArchive,
  downloadClawHubSkillArchive,
  downloadClawHubSkillArchiveUrl,
  fetchClawHubSkillDetail,
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillVerification,
  isDefaultClawHubBaseUrl,
  reportClawHubSkillInstallTelemetry,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
  type ClawHubDownloadResult,
  type ClawHubSkillDetail,
  type ClawHubSkillInstallResolutionResponse,
  type ClawHubSkillSearchResult,
  type ClawHubSkillVerificationResponse,
} from "../../infra/clawhub.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
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

type ClawHubSkillDownloadedArtifactLock = {
  kind: ClawHubDownloadResult["artifact"];
  sha256: string;
  integrity: string;
};

type ClawHubSkillFileLock = {
  path: string;
  sha256: string;
};

type ClawHubSkillVerificationLock = {
  schema: ClawHubSkillVerificationResponse["schema"];
  ok: boolean;
  decision: ClawHubSkillVerificationResponse["decision"];
  reasons: string[];
  card?: unknown;
  artifact?: unknown;
  provenance?: unknown;
  security?: unknown;
  signature?: unknown;
};

type ClawHubSkillLockEntry = {
  version: string;
  installedAt: number;
  registry?: string;
  ownerHandle?: string;
  sourceUrl?: string;
  artifact?: ClawHubSkillDownloadedArtifactLock;
  skillFile?: ClawHubSkillFileLock;
  verification?: ClawHubSkillVerificationLock;
};

type ClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  ownerHandle?: string;
  installedVersion: string;
  installedAt: number;
  sourceUrl?: string;
  artifact?: ClawHubSkillDownloadedArtifactLock;
  skillFile?: ClawHubSkillFileLock;
};

type ClawHubSkillsLockfile = {
  version: 1;
  skills: Record<string, ClawHubSkillLockEntry>;
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
      ownerHandle?: string;
      installedVersion: string;
      installedAt: number;
      originPath: string;
      lockPath: string;
      sourceUrl?: string;
      artifact?: ClawHubSkillDownloadedArtifactLock;
      skillFile?: ClawHubSkillFileLock;
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

type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail?: ClawHubSkillDetail;
      warning?: string;
    }
  | { ok: false; error: string; code?: ClawHubTrustErrorCode; version?: string; warning?: string };

type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
      warning?: string;
    }
  | { ok: false; error: string; code?: ClawHubTrustErrorCode; version?: string; warning?: string };

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  terminalLinks?: boolean;
};

type ClawHubSkillRef = {
  slug: string;
  ownerHandle?: string;
};

const CLAWHUB_OWNER_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;

function normalizeClawHubOwnerHandle(raw: string): string {
  const ownerHandle = raw.trim().toLowerCase();
  if (!CLAWHUB_OWNER_HANDLE_PATTERN.test(ownerHandle)) {
    throw new Error(`Invalid ClawHub owner handle: ${raw}`);
  }
  return ownerHandle;
}

function parseRequestedClawHubSkillRef(raw: string): ClawHubSkillRef {
  const value = raw.trim();
  if (!value.startsWith("@")) {
    return { slug: validateRequestedSkillSlug(value) };
  }
  const parts = value.slice(1).split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid ClawHub skill reference: ${raw}`);
  }
  const [owner, slug] = parts;
  if (!owner || !slug) {
    throw new Error(`Invalid ClawHub skill reference: ${raw}`);
  }
  return {
    ownerHandle: normalizeClawHubOwnerHandle(owner),
    slug: validateRequestedSkillSlug(slug),
  };
}

function formatClawHubSkillRef(ref: ClawHubSkillRef): string {
  return ref.ownerHandle ? `@${ref.ownerHandle}/${ref.slug}` : ref.slug;
}

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const requested = params.requestedSlug.trim();
  const requestedRef = requested.startsWith("@")
    ? parseRequestedClawHubSkillRef(requested)
    : { slug: normalizeTrackedSkillSlug(requested) };
  const trackedSlug = requestedRef.slug;
  const trackedTargetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug);
  const trackedOrigin = await readClawHubSkillOrigin(trackedTargetDir);
  const trackedLockEntry = params.lock.skills[trackedSlug];
  if (trackedOrigin || trackedLockEntry) {
    const trackedOwnerHandle = trackedOrigin?.ownerHandle ?? trackedLockEntry?.ownerHandle;
    if (requestedRef.ownerHandle && trackedOwnerHandle !== requestedRef.ownerHandle) {
      const trackedRef = trackedOwnerHandle ? `@${trackedOwnerHandle}/${trackedSlug}` : trackedSlug;
      throw new Error(
        `Skill "${trackedSlug}" is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${trackedSlug}.`,
      );
    }
    return trackedSlug;
  }
  return validateRequestedSkillSlug(requestedRef.slug);
}

type ClawHubInstallParams = {
  workspaceDir: string;
  slug: string;
  ownerHandle?: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
};

type ClawHubOfficialFlagContainer = {
  channel?: unknown;
  official?: unknown;
  isOfficial?: unknown;
};

function hasOfficialClawHubFlag(value: ClawHubOfficialFlagContainer | null | undefined): boolean {
  return value?.channel === "official" || value?.official === true || value?.isOfficial === true;
}

function isDefaultOfficialClawHubSkillSource(params: {
  baseUrl?: string;
  detail?: ClawHubSkillDetail;
  resolution?: Extract<ClawHubSkillInstallResolutionResponse, { ok: true }>;
}): boolean {
  if (!isDefaultClawHubBaseUrl(params.baseUrl)) {
    return false;
  }
  return (
    hasOfficialClawHubFlag(params.detail?.skill) ||
    hasOfficialClawHubFlag(params.detail?.owner) ||
    hasOfficialClawHubFlag(params.resolution) ||
    (params.resolution?.installKind === "archive" &&
      hasOfficialClawHubFlag(params.resolution.archive))
  );
}

async function fetchDefaultClawHubSkillDetailIfOfficial(params: {
  baseUrl?: string;
  slug: string;
  ownerHandle?: string;
}): Promise<ClawHubSkillDetail | undefined> {
  if (!isDefaultClawHubBaseUrl(params.baseUrl)) {
    return undefined;
  }
  try {
    const detail = await fetchClawHubSkillDetail({
      slug: params.slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
      baseUrl: params.baseUrl,
    });
    return isDefaultOfficialClawHubSkillSource({ baseUrl: params.baseUrl, detail })
      ? detail
      : undefined;
  } catch {
    return undefined;
  }
}

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      ownerHandle?: string;
      baseUrl?: string;
      previousVersion: string | null;
    }
  | {
      ok: false;
      slug: string;
      error: string;
    };

type ClawHubSkillVerificationResolutionSource = "installed" | "registry";
type ClawHubSkillVerificationSelector = "installed-version" | "version" | "tag" | "latest";

type ClawHubSkillVerificationTargetResult =
  | {
      ok: true;
      slug: string;
      ownerHandle?: string;
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

async function readClawHubSkillsLockfile(workspaceDir: string): Promise<ClawHubSkillsLockfile> {
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

function normalizeOptionalStringValue(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function normalizeGitHubRepoName(raw: unknown): string | undefined {
  const repo = normalizeOptionalStringValue(raw);
  if (!repo) {
    return undefined;
  }
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    return undefined;
  }
  return repo;
}

function normalizeGitHubCommitSegment(raw: unknown): string | undefined {
  const commit = normalizeOptionalStringValue(raw);
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
    return undefined;
  }
  return commit;
}

function buildGitHubTreeUrl(params: { repo: string; commit: string; sourcePath?: string }): string {
  const [owner, name] = params.repo.split("/") as [string, string];
  const pathParts = params.sourcePath ? params.sourcePath.split("/") : [];
  const segments = [owner, name, "tree", params.commit, ...pathParts];
  return `https://github.com/${segments.map(encodeURIComponent).join("/")}`;
}

export function readVerifiedClawHubSkillSourceUrl(raw: unknown): string | undefined {
  const provenance = asRecord(raw);
  // Only this ClawHub variant is server-resolved; other provenance metadata
  // must not become a trusted source link.
  if (provenance?.source !== "server-resolved-github-import") {
    return undefined;
  }
  const repo = normalizeGitHubRepoName(provenance.repo);
  const commit = normalizeGitHubCommitSegment(provenance.commit);
  if (!repo || !commit) {
    return undefined;
  }
  const pathValue = normalizeOptionalStringValue(provenance.path);
  let sourcePath: string | undefined;
  if (pathValue) {
    try {
      sourcePath = normalizeGitHubSourcePath(pathValue);
    } catch {
      return undefined;
    }
  }
  return buildGitHubTreeUrl({ repo, commit, ...(sourcePath ? { sourcePath } : {}) });
}

function readInstallResolutionSourceUrl(
  resolution: Extract<ClawHubSkillInstallResolutionResponse, { ok: true }> | undefined,
): string | undefined {
  if (resolution?.installKind !== "github") {
    return undefined;
  }
  return normalizeOptionalStringValue(resolution.github.sourceUrl);
}

function buildDownloadedArtifactLock(
  archive: ClawHubDownloadResult,
): ClawHubSkillDownloadedArtifactLock {
  return {
    kind: archive.artifact,
    sha256: archive.sha256Hex,
    integrity: archive.integrity,
  };
}

function snapshotClawHubSkillVerification(
  verification: ClawHubSkillVerificationResponse,
): ClawHubSkillVerificationLock {
  return {
    schema: verification.schema,
    ok: verification.ok,
    decision: verification.decision,
    reasons: [...verification.reasons],
    ...(verification.card !== undefined ? { card: verification.card } : {}),
    ...(verification.artifact !== undefined ? { artifact: verification.artifact } : {}),
    ...(verification.provenance !== undefined ? { provenance: verification.provenance } : {}),
    ...(verification.security !== undefined ? { security: verification.security } : {}),
    ...(verification.signature !== undefined ? { signature: verification.signature } : {}),
  };
}

async function fetchInstallVerificationLock(params: {
  slug: string;
  ownerHandle?: string;
  version?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<ClawHubSkillVerificationLock | undefined> {
  try {
    const verification = await fetchClawHubSkillVerification({
      slug: params.slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
      version: params.version,
      baseUrl: params.baseUrl,
    });
    return snapshotClawHubSkillVerification(verification);
  } catch (err) {
    params.logger?.warn?.(
      `Skill verification for ${formatClawHubSkillRef(params)} failed: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

async function readInstalledSkillFileLock(
  skillDir: string,
): Promise<ClawHubSkillFileLock | undefined> {
  for (const marker of CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS) {
    const candidate = path.join(skillDir, marker);
    try {
      const content = await fs.readFile(candidate);
      return {
        path: marker,
        sha256: sha256Hex(content),
      };
    } catch {
      continue;
    }
  }
  return undefined;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeDownloadedArtifactLock(
  raw: unknown,
): ClawHubSkillDownloadedArtifactLock | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = raw as Partial<ClawHubSkillDownloadedArtifactLock>;
  if (
    (candidate.kind === "archive" || candidate.kind === "clawpack") &&
    isNonEmptyString(candidate.sha256) &&
    isNonEmptyString(candidate.integrity)
  ) {
    return {
      kind: candidate.kind,
      sha256: candidate.sha256,
      integrity: candidate.integrity,
    };
  }
  return undefined;
}

function normalizeSkillFileLock(raw: unknown): ClawHubSkillFileLock | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = raw as Partial<ClawHubSkillFileLock>;
  if (isNonEmptyString(candidate.path) && isNonEmptyString(candidate.sha256)) {
    return { path: candidate.path, sha256: candidate.sha256 };
  }
  return undefined;
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
    const sourceUrl = normalizeOptionalStringValue((raw as { sourceUrl?: unknown }).sourceUrl);
    const ownerHandleRaw = normalizeOptionalStringValue(
      (raw as { ownerHandle?: unknown }).ownerHandle,
    );
    let ownerHandle: string | undefined;
    if (ownerHandleRaw) {
      try {
        ownerHandle = normalizeClawHubOwnerHandle(ownerHandleRaw);
      } catch {
        return null;
      }
    }
    const artifact = normalizeDownloadedArtifactLock((raw as { artifact?: unknown }).artifact);
    const skillFile = normalizeSkillFileLock((raw as { skillFile?: unknown }).skillFile);
    return {
      version: 1,
      registry: normalizeStoredRegistry(raw.registry),
      slug: raw.slug,
      ...(ownerHandle ? { ownerHandle } : {}),
      installedVersion: raw.installedVersion,
      installedAt: raw.installedAt,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(artifact ? { artifact } : {}),
      ...(skillFile ? { skillFile } : {}),
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
  lockfileScope?: "workspace" | "managed";
}): ClawHubSkillStatusLink | undefined {
  const originRead = readClawHubSkillOriginStatusSync(params.skillDir);
  const lockRead = params.lockRead ?? readClawHubSkillsLockfileStatusSync(params.workspaceDir);
  const lockfileLabel = `${params.lockfileScope ?? "workspace"} ClawHub lockfile`;
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
      reason: `Skill "${trackedSlug}" is tracked by the ${lockfileLabel} but is missing local ClawHub origin metadata.`,
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
      reason: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the ${lockfileLabel}.`,
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
      reason: `Malformed ${lockfileLabel} at ${lockRead.path}: ${lockRead.error}`,
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
      reason: `Skill "${trackedSlug}" has ClawHub origin metadata but is not tracked by the ${lockfileLabel}.`,
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
  const lockedSourceUrl = normalizeOptionalStringValue(locked.sourceUrl);
  const lockedOwnerHandle = normalizeOptionalStringValue(locked.ownerHandle);
  const lockedArtifact = normalizeDownloadedArtifactLock(locked.artifact);
  const lockedSkillFile = normalizeSkillFileLock(locked.skillFile);
  const provenanceMatches =
    originRead.origin.ownerHandle === lockedOwnerHandle &&
    originRead.origin.sourceUrl === lockedSourceUrl &&
    originRead.origin.artifact?.kind === lockedArtifact?.kind &&
    originRead.origin.artifact?.sha256 === lockedArtifact?.sha256 &&
    originRead.origin.artifact?.integrity === lockedArtifact?.integrity &&
    originRead.origin.skillFile?.path === lockedSkillFile?.path &&
    originRead.origin.skillFile?.sha256 === lockedSkillFile?.sha256;
  // A linked status is a trust signal. Only expose provenance when both
  // install records agree, so a one-sided origin edit cannot become trusted.
  if (
    locked.version !== originRead.origin.installedVersion ||
    locked.installedAt !== originRead.origin.installedAt ||
    lockedRegistry !== originRegistry ||
    !provenanceMatches
  ) {
    return {
      status: "invalid",
      valid: false,
      reason: `Skill "${trackedSlug}" ClawHub origin metadata does not match the ${lockfileLabel}.`,
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
    ...(lockedOwnerHandle ? { ownerHandle: lockedOwnerHandle } : {}),
    installedVersion: locked.version,
    installedAt: locked.installedAt,
    originPath: originRead.path,
    lockPath: lockRead.path,
    ...(lockedSourceUrl ? { sourceUrl: lockedSourceUrl } : {}),
    ...(lockedArtifact ? { artifact: lockedArtifact } : {}),
    ...(lockedSkillFile ? { skillFile: lockedSkillFile } : {}),
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

    const requestedRef = parseRequestedClawHubSkillRef(params.slug);
    const trackedSlug = requestedRef.slug;
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
      const lockedOwnerHandle = normalizeOptionalStringValue(locked.ownerHandle);
      if (
        locked.version !== originRead.origin.installedVersion ||
        locked.installedAt !== originRead.origin.installedAt ||
        lockedRegistry !== originRegistry ||
        originRead.origin.ownerHandle !== lockedOwnerHandle
      ) {
        return {
          ok: false,
          error: `Skill "${trackedSlug}" ClawHub origin metadata does not match the workspace ClawHub lockfile. Reinstall it from ClawHub before verifying it as an installed ClawHub skill.`,
        };
      }
      if (requestedRef.ownerHandle && lockedOwnerHandle !== requestedRef.ownerHandle) {
        const trackedRef = lockedOwnerHandle ? `@${lockedOwnerHandle}/${trackedSlug}` : trackedSlug;
        return {
          ok: false,
          error: `Skill "${trackedSlug}" is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${trackedSlug}.`,
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
        ...(lockedOwnerHandle ? { ownerHandle: lockedOwnerHandle } : {}),
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

    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const selector: ClawHubSkillVerificationSelector = version ? "version" : tag ? "tag" : "latest";
    return {
      ok: true,
      slug: requestedRef.slug,
      ...(requestedRef.ownerHandle ? { ownerHandle: requestedRef.ownerHandle } : {}),
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
  ownerHandle?: string;
  version?: string;
  baseUrl?: string;
}): Promise<{ detail: ClawHubSkillDetail; version: string }> {
  const detail = await fetchClawHubSkillDetail({
    slug: params.slug,
    ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
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

function normalizeGitHubSourcePath(raw: string): string {
  const parts = raw.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid GitHub skill source path: ${raw}`);
  }
  return parts.join("/");
}

function resolveGitHubSkillSourceDir(repoRoot: string, sourcePath: string): string {
  const normalized = normalizeGitHubSourcePath(sourcePath);
  return path.join(repoRoot, ...normalized.split("/"));
}

async function installArchiveResolution(params: {
  workspaceDir: string;
  slug: string;
  ownerHandle?: string;
  version: string;
  archivePath: string;
  registry: string;
  authority: "official" | "openclaw" | "third-party";
  force?: boolean;
  logger?: Logger;
  config?: OpenClawConfig;
}) {
  return await withExtractedArchiveRoot({
    archivePath: params.archivePath,
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
        policy: {
          config: params.config,
          installId: "clawhub",
          origin: {
            type: "clawhub",
            registry: params.registry,
            slug: params.slug,
            ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
            version: params.version,
          },
          source: {
            kind: "clawhub",
            authority: params.authority,
            mutable: false,
            network: true,
          },
          requestedSpecifier: `clawhub:${formatClawHubSkillRef(params)}@${params.version}`,
        },
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
      }),
  });
}

async function installGitHubResolution(params: {
  workspaceDir: string;
  slug: string;
  ownerHandle?: string;
  sourcePath: string;
  archivePath: string;
  registry: string;
  authority: "official" | "third-party";
  repo: string;
  commit: string;
  force?: boolean;
  logger?: Logger;
  config?: OpenClawConfig;
}) {
  return await withExtractedArchiveRoot({
    archivePath: params.archivePath,
    tempDirPrefix: "openclaw-skill-clawhub-github-",
    timeoutMs: 120_000,
    onExtracted: async (repoRoot) =>
      await installExtractedSkillRoot({
        workspaceDir: params.workspaceDir,
        slug: params.slug,
        extractedRoot: resolveGitHubSkillSourceDir(repoRoot, params.sourcePath),
        mode: params.force ? "update" : "install",
        logger: params.logger,
        policy: {
          config: params.config,
          installId: "clawhub",
          origin: {
            type: "clawhub",
            registry: params.registry,
            slug: params.slug,
            ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
            version: params.commit,
            repo: params.repo,
            path: params.sourcePath,
            commit: params.commit,
          },
          source: {
            kind: "git",
            authority: params.authority,
            mutable: false,
            network: true,
          },
          requestedSpecifier: `clawhub:${formatClawHubSkillRef(params)}@${params.commit}`,
        },
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
      }),
  });
}

function assertInstallResolutionAllowed(
  resolution: ClawHubSkillInstallResolutionResponse,
): Extract<ClawHubSkillInstallResolutionResponse, { ok: true }> {
  if (!resolution.ok) {
    if (resolution.reason === "ambiguous_slug") {
      const message = resolution.message ? ` ${resolution.message}` : "";
      throw new Error(
        `Skill "${resolution.slug}" is ambiguous on ClawHub. Install an owner-qualified skill, for example: openclaw skills install @owner/${resolution.slug}.${message}`,
      );
    }
    throw new Error(resolution.message || `Skill "${resolution.slug}" is not installable.`);
  }
  if (resolution.installKind !== "github") {
    return resolution;
  }
  const commit = normalizeGitHubCommitSegment(resolution.github.commit)?.toLowerCase();
  if (!commit) {
    throw new Error(
      `Skill "${resolution.slug}" resolved to a mutable or invalid GitHub source ref; expected a full 40-character commit SHA.`,
    );
  }
  return { ...resolution, github: { ...resolution.github, commit } };
}

async function ensureClawHubSkillTrustAcknowledged(
  params: ClawHubInstallParams & {
    version: string;
    skipClawHubTrustCheck?: boolean;
  },
): Promise<
  | { ok: true; warning?: string }
  | { ok: false; error: string; code?: ClawHubTrustErrorCode; warning?: string }
> {
  if (params.skipClawHubTrustCheck) {
    return { ok: true };
  }
  const result = await ensureClawHubPackageTrustAcknowledged({
    subject: {
      kind: "skill",
      packageName: params.slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
    },
    version: params.version,
    baseUrl: params.baseUrl,
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    onClawHubRisk: params.onClawHubRisk,
    logger: params.logger,
    mode: params.force ? "update" : "install",
  });
  return result.ok
    ? { ok: true, ...(result.warning ? { warning: result.warning } : {}) }
    : {
        ok: false,
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
      };
}

async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const clawhubAuthority = isDefaultClawHubBaseUrl(params.baseUrl) ? "openclaw" : "third-party";
    if (!params.force && (await pathExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    let version!: string;
    let detail: ClawHubSkillDetail | undefined;
    let latestResolution: Extract<ClawHubSkillInstallResolutionResponse, { ok: true }> | undefined;
    let install: Awaited<ReturnType<typeof installArchiveResolution>>;
    let trustWarning: string | undefined;
    let officialClawHubSkill = false;

    let archive: ClawHubDownloadResult;
    if (params.version) {
      const resolved = await resolveInstallVersion({
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        version: params.version,
        baseUrl: params.baseUrl,
      });
      detail = resolved.detail;
      version = resolved.version;
      officialClawHubSkill = isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        detail,
      });
      const trust = await ensureClawHubSkillTrustAcknowledged({
        ...params,
        version,
        skipClawHubTrustCheck: officialClawHubSkill,
      });
      if (!trust.ok) {
        return { ...trust, version };
      }
      trustWarning = trust.warning;
      params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
      archive = await downloadClawHubSkillArchive({
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        version,
        baseUrl: params.baseUrl,
      });
    } else {
      latestResolution = assertInstallResolutionAllowed(
        await fetchClawHubSkillInstallResolution({
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          baseUrl: params.baseUrl,
          ...(params.forceInstall ? { forceInstall: true } : {}),
        }),
      );
      const resolutionOfficialClawHubSkill = isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        resolution: latestResolution,
      });
      detail = resolutionOfficialClawHubSkill
        ? undefined
        : await fetchDefaultClawHubSkillDetailIfOfficial({
            baseUrl: params.baseUrl,
            slug: params.slug,
            ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          });
      if (latestResolution.installKind === "github") {
        version = latestResolution.github.commit;
        officialClawHubSkill = isDefaultOfficialClawHubSkillSource({
          baseUrl: params.baseUrl,
          detail,
          resolution: latestResolution,
        });
        // GitHub-backed ClawHub skills are commit resolutions, not ClawHub skill
        // release versions; the install resolver owns their scan/force policy.
        params.logger?.info?.(`Downloading ${params.slug}@${version} from GitHub…`);
        archive = await downloadClawHubGitHubSkillArchive({
          repo: latestResolution.github.repo,
          commit: latestResolution.github.commit,
        });
      } else {
        version = latestResolution.archive.version;
        officialClawHubSkill = isDefaultOfficialClawHubSkillSource({
          baseUrl: params.baseUrl,
          detail,
          resolution: latestResolution,
        });
        const trust = await ensureClawHubSkillTrustAcknowledged({
          ...params,
          version,
          skipClawHubTrustCheck: officialClawHubSkill,
        });
        if (!trust.ok) {
          return { ...trust, version };
        }
        trustWarning = trust.warning;
        params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
        archive = await downloadClawHubSkillArchiveUrl({
          url: latestResolution.archive.downloadUrl,
          baseUrl: params.baseUrl,
        });
      }
    }
    try {
      if (!params.version) {
        if (!latestResolution) {
          throw new Error(`Skill "${params.slug}" has no install resolution.`);
        }
        install =
          latestResolution.installKind === "github"
            ? await installGitHubResolution({
                workspaceDir: params.workspaceDir,
                slug: params.slug,
                ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
                sourcePath: latestResolution.github.path,
                archivePath: archive.archivePath,
                registry,
                authority: officialClawHubSkill ? "official" : "third-party",
                repo: latestResolution.github.repo,
                commit: latestResolution.github.commit,
                force: params.force,
                logger: params.logger,
                config: params.config,
              })
            : await installArchiveResolution({
                workspaceDir: params.workspaceDir,
                slug: params.slug,
                ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
                version,
                archivePath: archive.archivePath,
                registry,
                authority: officialClawHubSkill ? "official" : clawhubAuthority,
                force: params.force,
                logger: params.logger,
                config: params.config,
              });
      } else {
        install = await installArchiveResolution({
          workspaceDir: params.workspaceDir,
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          version,
          archivePath: archive.archivePath,
          registry,
          authority: officialClawHubSkill ? "official" : clawhubAuthority,
          force: params.force,
          logger: params.logger,
          config: params.config,
        });
      }
      if (!install.ok) {
        return { ok: false, error: install.error };
      }

      const installedAt = Date.now();
      const artifact = buildDownloadedArtifactLock(archive);
      const verificationVersion =
        latestResolution?.installKind === "github" && !params.version ? undefined : version;
      const [skillFile, verification] = await Promise.all([
        readInstalledSkillFileLock(install.targetDir),
        fetchInstallVerificationLock({
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          version: verificationVersion,
          baseUrl: params.baseUrl,
          logger: params.logger,
        }),
      ]);
      const sourceUrl =
        readInstallResolutionSourceUrl(latestResolution) ??
        readVerifiedClawHubSkillSourceUrl(verification?.provenance);
      await writeClawHubSkillOrigin(install.targetDir, {
        version: 1,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        installedVersion: version,
        installedAt,
        ...(sourceUrl ? { sourceUrl } : {}),
        artifact,
        ...(skillFile ? { skillFile } : {}),
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[params.slug] = {
        version,
        installedAt,
        registry: resolveClawHubBaseUrl(params.baseUrl),
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        artifact,
        ...(skillFile ? { skillFile } : {}),
        ...(verification ? { verification } : {}),
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);
      await reportClawHubSkillInstallTelemetry({
        baseUrl: params.baseUrl,
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        version,
      }).catch(() => undefined);

      return {
        ok: true,
        slug: params.slug,
        version,
        targetDir: install.targetDir,
        ...(detail ? { detail } : {}),
        ...(trustWarning ? { warning: trustWarning } : {}),
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
    const ref = parseRequestedClawHubSkillRef(params.slug);
    return await performClawHubSkillInstall({
      ...params,
      slug: ref.slug,
      ...(ref.ownerHandle ? { ownerHandle: ref.ownerHandle } : {}),
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
  const lockEntry = params.lock.skills[params.slug];
  const ownerHandle = origin?.ownerHandle ?? lockEntry?.ownerHandle;
  return {
    ok: true,
    slug: params.slug,
    ...(ownerHandle ? { ownerHandle } : {}),
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? lockEntry?.version ?? null,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
}): Promise<InstallClawHubSkillResult> {
  return await installRequestedSkillFromClawHub(params);
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  forceInstall?: boolean;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
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
      ...(tracked.ownerHandle ? { ownerHandle: tracked.ownerHandle } : {}),
      baseUrl: tracked.baseUrl,
      force: true,
      forceInstall: params.forceInstall,
      acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
      onClawHubRisk: params.onClawHubRisk,
      logger: params.logger,
      config: params.config,
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
      ...(install.warning ? { warning: install.warning } : {}),
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

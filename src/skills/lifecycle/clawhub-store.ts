import fsSync from "node:fs";
import path from "node:path";
import {
  CLAWHUB_SKILLS_SH_TRUST_STATE,
  type ClawHubDownloadResult,
  type ClawHubSkillVerificationResponse,
  type ClawHubSkillsShTrustState,
} from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readJsonIfExists, tryReadJson, writeJson } from "../../infra/json-files.js";
import { normalizeTrackedSkillSlug, validateRequestedSkillSlug } from "./archive-install.js";

const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIR = ".clawdhub";
const CLAWHUB_OWNER_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export type ClawHubSkillDownloadedArtifactLock = {
  kind: ClawHubDownloadResult["artifact"];
  sha256: string;
  integrity: string;
};

export type ClawHubSkillFileLock = {
  path: string;
  sha256: string;
};

export type ClawHubSkillVerificationLock = {
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
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
  sourceUrl?: string;
  artifact?: ClawHubSkillDownloadedArtifactLock;
  skillFile?: ClawHubSkillFileLock;
  fileTreeSha256?: string;
  verification?: ClawHubSkillVerificationLock;
};

type ClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
  installedVersion: string;
  installedAt: number;
  sourceUrl?: string;
  artifact?: ClawHubSkillDownloadedArtifactLock;
  skillFile?: ClawHubSkillFileLock;
  fileTreeSha256?: string;
};

export type ClawHubSkillsLockfile = {
  version: 1;
  skills: Record<string, ClawHubSkillLockEntry>;
};

export type ClawHubSkillsLockfileStatusRead =
  | { kind: "found"; lock: ClawHubSkillsLockfile; path: string }
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string };

export type ClawHubSkillRef = {
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
};

type StrictOriginReadResult =
  | { kind: "found"; origin: ClawHubSkillOrigin; path: string }
  | { kind: "missing" }
  | { kind: "malformed"; path: string; error: string };

function metadataPaths(rootDir: string, filename: string): string[] {
  return [path.join(rootDir, DOT_DIR, filename), path.join(rootDir, LEGACY_DOT_DIR, filename)];
}

function normalizeClawHubOwnerHandle(raw: string): string {
  const ownerHandle = raw.trim().toLowerCase();
  if (!CLAWHUB_OWNER_HANDLE_PATTERN.test(ownerHandle)) {
    throw new Error(`Invalid ClawHub owner handle: ${raw}`);
  }
  return ownerHandle;
}

export function parseRequestedClawHubSkillRef(raw: string): ClawHubSkillRef {
  const value = raw.trim();
  if (value.startsWith("skills-sh/")) {
    throw new Error(`Invalid skills.sh skill reference: ${raw}`);
  }
  if (value.startsWith("skills-sh:")) {
    const parts = value.slice("skills-sh:".length).split("/");
    if (parts.length !== 3) {
      throw new Error(`Invalid skills.sh skill reference: ${raw}`);
    }
    const [owner, repo, slug] = parts;
    if (
      !owner ||
      !repo ||
      !slug ||
      !GITHUB_OWNER_PATTERN.test(owner) ||
      !GITHUB_REPO_PATTERN.test(repo) ||
      repo === "." ||
      repo === ".."
    ) {
      throw new Error(`Invalid skills.sh skill reference: ${raw}`);
    }
    return {
      slug: validateRequestedSkillSlug(slug),
      requestedReference: value,
      trustState: CLAWHUB_SKILLS_SH_TRUST_STATE,
    };
  }
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

export function formatClawHubSkillRef(ref: ClawHubSkillRef): string {
  return ref.ownerHandle ? `@${ref.ownerHandle}/${ref.slug}` : ref.slug;
}

export function normalizeStoredRegistry(registry: string): string {
  const trimmed = registry.trim();
  return trimmed.replace(/\/+$/, "") || trimmed;
}

export function normalizeOptionalStringValue(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function normalizeGitHubCommitSegment(raw: unknown): string | undefined {
  const commit = normalizeOptionalStringValue(raw);
  return commit && /^[0-9a-f]{40}$/i.test(commit) ? commit : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeDownloadedArtifactLock(
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
    return { kind: candidate.kind, sha256: candidate.sha256, integrity: candidate.integrity };
  }
  return undefined;
}

export function normalizeSkillFileLock(raw: unknown): ClawHubSkillFileLock | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = raw as Partial<ClawHubSkillFileLock>;
  return isNonEmptyString(candidate.path) && isNonEmptyString(candidate.sha256)
    ? { path: candidate.path, sha256: candidate.sha256 }
    : undefined;
}

function normalizeClawHubSkillOrigin(
  raw: Partial<ClawHubSkillOrigin> | null,
): ClawHubSkillOrigin | null {
  if (
    raw?.version !== 1 ||
    !isNonEmptyString(raw.registry) ||
    !isNonEmptyString(raw.slug) ||
    !isNonEmptyString(raw.installedVersion) ||
    typeof raw.installedAt !== "number"
  ) {
    return null;
  }
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
  const requestedReferenceRaw = normalizeOptionalStringValue(
    (raw as { requestedReference?: unknown }).requestedReference,
  );
  let requestedReference: string | undefined;
  let trustState: ClawHubSkillsShTrustState | undefined;
  if (requestedReferenceRaw) {
    try {
      const parsed = parseRequestedClawHubSkillRef(requestedReferenceRaw);
      if (!parsed.requestedReference || parsed.slug !== raw.slug) {
        return null;
      }
      requestedReference = parsed.requestedReference;
      const rawTrustState = normalizeOptionalStringValue(
        (raw as { trustState?: unknown }).trustState,
      );
      if (rawTrustState !== CLAWHUB_SKILLS_SH_TRUST_STATE) {
        return null;
      }
      trustState = CLAWHUB_SKILLS_SH_TRUST_STATE;
    } catch {
      return null;
    }
  } else if ((raw as { trustState?: unknown }).trustState !== undefined) {
    return null;
  }
  const artifact = normalizeDownloadedArtifactLock((raw as { artifact?: unknown }).artifact);
  const skillFile = normalizeSkillFileLock((raw as { skillFile?: unknown }).skillFile);
  const fileTreeSha256 = normalizeOptionalStringValue(
    (raw as { fileTreeSha256?: unknown }).fileTreeSha256,
  );
  return {
    version: 1,
    registry: normalizeStoredRegistry(raw.registry),
    slug: raw.slug,
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(requestedReference ? { requestedReference } : {}),
    ...(trustState ? { trustState } : {}),
    installedVersion: raw.installedVersion,
    installedAt: raw.installedAt,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(artifact ? { artifact } : {}),
    ...(skillFile ? { skillFile } : {}),
    ...(fileTreeSha256 ? { fileTreeSha256 } : {}),
  };
}

export async function readClawHubSkillsLockfile(
  workspaceDir: string,
): Promise<ClawHubSkillsLockfile> {
  for (const candidate of metadataPaths(workspaceDir, "lock.json")) {
    try {
      const raw = await tryReadJson<Partial<ClawHubSkillsLockfile>>(candidate);
      if (raw?.version === 1 && raw.skills && typeof raw.skills === "object") {
        return { version: 1, skills: raw.skills };
      }
    } catch {
      // ignore
    }
  }
  return { version: 1, skills: {} };
}

export async function writeClawHubSkillsLockfile(
  workspaceDir: string,
  lockfile: ClawHubSkillsLockfile,
): Promise<void> {
  await writeJson(path.join(workspaceDir, DOT_DIR, "lock.json"), lockfile, {
    trailingNewline: true,
  });
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

export function readClawHubSkillsLockfileStatusSync(
  workspaceDir: string,
): ClawHubSkillsLockfileStatusRead {
  for (const candidate of metadataPaths(workspaceDir, "lock.json")) {
    try {
      const read = readJsonIfExistsSync(candidate);
      if (!read.exists) {
        continue;
      }
      const raw = read.value as Partial<ClawHubSkillsLockfile>;
      return raw?.version === 1 && raw.skills && typeof raw.skills === "object"
        ? { kind: "found", path: candidate, lock: { version: 1, skills: raw.skills } }
        : {
            kind: "malformed",
            path: candidate,
            error: "expected version 1 lockfile with skills",
          };
    } catch (err) {
      return { kind: "malformed", path: candidate, error: formatErrorMessage(err) };
    }
  }
  return { kind: "missing" };
}

function originResult(
  raw: Partial<ClawHubSkillOrigin> | null,
  candidate: string,
): StrictOriginReadResult {
  const origin = normalizeClawHubSkillOrigin(raw);
  return origin
    ? { kind: "found", origin, path: candidate }
    : {
        kind: "malformed",
        path: candidate,
        error: "expected version 1 origin with registry, slug, installedVersion, and installedAt",
      };
}

export async function readClawHubSkillOrigin(skillDir: string): Promise<ClawHubSkillOrigin | null> {
  for (const candidate of metadataPaths(skillDir, "origin.json")) {
    try {
      const origin = normalizeClawHubSkillOrigin(
        await tryReadJson<Partial<ClawHubSkillOrigin>>(candidate),
      );
      if (origin) {
        return origin;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function readClawHubSkillOriginStatusSync(skillDir: string): StrictOriginReadResult {
  for (const candidate of metadataPaths(skillDir, "origin.json")) {
    try {
      const read = readJsonIfExistsSync(candidate);
      if (read.exists) {
        return originResult(read.value as Partial<ClawHubSkillOrigin>, candidate);
      }
    } catch (err) {
      return { kind: "malformed", path: candidate, error: formatErrorMessage(err) };
    }
  }
  return { kind: "missing" };
}

export async function readClawHubSkillOriginStrict(
  skillDir: string,
): Promise<StrictOriginReadResult> {
  for (const candidate of metadataPaths(skillDir, "origin.json")) {
    try {
      const raw = await readJsonIfExists<Partial<ClawHubSkillOrigin>>(candidate);
      if (raw) {
        return originResult(raw, candidate);
      }
    } catch (err) {
      return { kind: "malformed", path: candidate, error: formatErrorMessage(err) };
    }
  }
  return { kind: "missing" };
}

export async function writeClawHubSkillOrigin(
  skillDir: string,
  origin: ClawHubSkillOrigin,
): Promise<void> {
  await writeJson(path.join(skillDir, DOT_DIR, "origin.json"), origin, { trailingNewline: true });
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  return Object.keys((await readClawHubSkillsLockfile(workspaceDir)).skills).toSorted();
}

export async function untrackClawHubSkill(
  workspaceDir: string,
  slug: string,
): Promise<() => Promise<void>> {
  const trackedSlug = normalizeTrackedSkillSlug(slug);
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  const previous = lock.skills[trackedSlug];
  if (!previous) {
    return async () => undefined;
  }
  delete lock.skills[trackedSlug];
  await writeClawHubSkillsLockfile(workspaceDir, lock);
  return async () => {
    const current = await readClawHubSkillsLockfile(workspaceDir);
    if (current.skills[trackedSlug]) {
      throw new Error(`Skill ${JSON.stringify(trackedSlug)} was retracked during rollback.`);
    }
    current.skills[trackedSlug] = previous;
    await writeClawHubSkillsLockfile(workspaceDir, current);
  };
}

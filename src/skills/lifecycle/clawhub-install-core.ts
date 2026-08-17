import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  downloadClawHubGitHubSkillArchive,
  downloadClawHubSkillArchive,
  downloadClawHubSkillArchiveUrl,
  normalizeClawHubSha256Integrity,
  type ClawHubDownloadResult,
} from "../../infra/clawhub-artifacts.js";
import {
  ClawHubRequestError,
  isDefaultClawHubBaseUrl,
  resolveClawHubBaseUrl,
} from "../../infra/clawhub-client.js";
import {
  type ClawHubTrustErrorCode,
  ensureClawHubPackageTrustAcknowledged,
  type ClawHubRiskAcknowledgementRequest,
} from "../../infra/clawhub-install-trust.js";
import {
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  CLAWHUB_SKILLS_SH_TRUST_STATE,
  fetchClawHubSkillDetail,
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillVerification,
  reportClawHubSkillInstallTelemetry,
  type ClawHubSkillDetail,
  type ClawHubSkillInstallResolutionResponse,
  type ClawHubSkillVerificationResponse,
  type ClawHubSkillsShTrustState,
} from "../../infra/clawhub-skills.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import { markClawPackageIndependentlyOwned } from "../../state/claw-package-adoption.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
  resolveWorkspaceSkillInstallDir,
} from "./archive-install.js";
import {
  formatClawHubSkillRef,
  normalizeGitHubCommitSegment,
  normalizeOptionalStringValue,
  readClawHubSkillsLockfile,
  writeClawHubSkillOrigin,
  writeClawHubSkillsLockfile,
  type ClawHubSkillDownloadedArtifactLock,
  type ClawHubSkillFileLock,
  type ClawHubSkillVerificationLock,
} from "./clawhub-store.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

export type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  terminalLinks?: boolean;
};

export type ClawHubInstallParams = {
  workspaceDir: string;
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
  version?: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  clawManaged?: boolean;
};

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      detail?: ClawHubSkillDetail;
      warning?: string;
    }
  | { ok: false; error: string; code?: ClawHubTrustErrorCode; version?: string; warning?: string };

export function normalizeExpectedArtifactIntegrity(expectedIntegrity: string): string;
export function normalizeExpectedArtifactIntegrity(expectedIntegrity: undefined): undefined;
export function normalizeExpectedArtifactIntegrity(
  expectedIntegrity: string | undefined,
): string | undefined;
export function normalizeExpectedArtifactIntegrity(
  expectedIntegrity: string | undefined,
): string | undefined {
  if (expectedIntegrity === undefined) {
    return undefined;
  }
  const normalized = normalizeClawHubSha256Integrity(expectedIntegrity);
  if (!normalized) {
    throw new Error(`Invalid expected ClawHub archive integrity: ${expectedIntegrity}`);
  }
  return normalized;
}

function assertDownloadedArtifactIntegrity(
  archive: ClawHubDownloadResult,
  expectedIntegrity: string | undefined,
): void {
  const normalizedExpected = normalizeExpectedArtifactIntegrity(expectedIntegrity);
  if (normalizedExpected && archive.integrity !== normalizedExpected) {
    throw new Error(
      `ClawHub archive integrity mismatch: expected ${normalizedExpected}, got ${archive.integrity}.`,
    );
  }
}

type ClawHubOfficialFlagContainer = {
  channel?: unknown;
  official?: unknown;
  isOfficial?: unknown;
};

function hasOfficialClawHubFlag(value: ClawHubOfficialFlagContainer | null | undefined): boolean {
  return value?.channel === "official" || value?.official === true || value?.isOfficial === true;
}

export function isDefaultOfficialClawHubSkillSource(params: {
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

export async function resolveInstallVersion(params: {
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
  const version = params.version ?? detail.latestVersion?.version;
  if (!version) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  return { detail, version };
}

function formatClawHubSkillInstallError(error: unknown, slug: string): string {
  if (!(error instanceof ClawHubRequestError)) {
    return formatErrorMessage(error);
  }
  const skillPath = `/api/v1/skills/${encodeURIComponent(slug)}`;
  if (
    error.status === 404 &&
    (error.requestPath.endsWith(skillPath) || error.requestPath.endsWith(`${skillPath}/install`))
  ) {
    return `Skill "${slug}" not found. Run \`openclaw skills list\` to see available skills.`;
  }
  if (error.status === 401) {
    return `ClawHub authentication failed while installing skill "${slug}". Authenticate with ClawHub and try again.`;
  }
  if (error.status === 403) {
    return `ClawHub denied access while installing skill "${slug}". Check your ClawHub access and try again.`;
  }
  if (error.status === 429) {
    return `ClawHub rate limit reached while installing skill "${slug}". Wait and try again later.`;
  }
  if (error.status >= 500) {
    return `ClawHub is temporarily unavailable while installing skill "${slug}". Try again later.`;
  }
  return `ClawHub could not install skill "${slug}". Check the skill reference and try again.`;
}

function normalizeGitHubSourcePath(raw: string): string {
  const parts = raw.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid GitHub skill source path: ${raw}`);
  }
  return parts.join("/");
}

function buildGitHubTreeUrl(params: { repo: string; commit: string; sourcePath?: string }): string {
  const [owner, name] = params.repo.split("/") as [string, string];
  const segments = [
    owner,
    name,
    "tree",
    params.commit,
    ...(params.sourcePath ? params.sourcePath.split("/") : []),
  ];
  return `https://github.com/${segments.map(encodeURIComponent).join("/")}`;
}

export function readVerifiedClawHubSkillSourceUrl(raw: unknown): string | undefined {
  const provenance =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  // Only this ClawHub variant is server-resolved; other provenance metadata
  // must not become a trusted source link.
  if (provenance?.source !== "server-resolved-github-import") {
    return undefined;
  }
  const repo = normalizeOptionalStringValue(provenance.repo);
  const repoParts = repo?.split("/");
  const commit = normalizeGitHubCommitSegment(provenance.commit);
  if (
    !repo ||
    repoParts?.length !== 2 ||
    repoParts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part)) ||
    !commit
  ) {
    return undefined;
  }
  const pathValue = normalizeOptionalStringValue(provenance.path);
  try {
    const sourcePath = pathValue ? normalizeGitHubSourcePath(pathValue) : undefined;
    return buildGitHubTreeUrl({ repo, commit, ...(sourcePath ? { sourcePath } : {}) });
  } catch {
    return undefined;
  }
}

function buildDownloadedArtifactLock(
  archive: ClawHubDownloadResult,
): ClawHubSkillDownloadedArtifactLock {
  return { kind: archive.artifact, sha256: archive.sha256Hex, integrity: archive.integrity };
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
  requestedReference?: string;
  version?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<ClawHubSkillVerificationLock | undefined> {
  try {
    const verification = await fetchClawHubSkillVerification({
      slug: params.slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
      ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
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
    try {
      return { path: marker, sha256: sha256Hex(await fs.readFile(path.join(skillDir, marker))) };
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveGitHubSkillSourceDir(repoRoot: string, sourcePath: string): string {
  return path.join(repoRoot, ...normalizeGitHubSourcePath(sourcePath).split("/"));
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
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
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
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          installId: "clawhub",
          origin: {
            type: "clawhub",
            registry: params.registry,
            slug: params.slug,
            ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
            version: params.version,
          },
          source: { kind: "clawhub", authority: params.authority, mutable: false, network: true },
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
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
  force?: boolean;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
}) {
  // Preserve the repository root for sourcePath selection. Root markers validate
  // the selected skill directory afterward, so nested paths are not applied twice.
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
          onInstallPolicyWarning: params.onInstallPolicyWarning,
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
            ...(params.requestedReference ? { reference: params.requestedReference } : {}),
            ...(params.trustState ? { trustState: params.trustState } : {}),
          },
          source: { kind: "git", authority: params.authority, mutable: false, network: true },
          requestedSpecifier:
            params.requestedReference ??
            `clawhub:${formatClawHubSkillRef(params)}@${params.commit}`,
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

export async function ensureClawHubSkillTrustAcknowledged(
  params: ClawHubInstallParams & { version: string; skipClawHubTrustCheck?: boolean },
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
      workspaceDir: params.workspaceDir,
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

export async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    normalizeExpectedArtifactIntegrity(params.expectedIntegrity);
    const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    if (!params.force && (await pathExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    let version: string;
    let detail: ClawHubSkillDetail | undefined;
    let resolution: Extract<ClawHubSkillInstallResolutionResponse, { ok: true }> | undefined;
    let trustWarning: string | undefined;
    let official = false;
    let archive: ClawHubDownloadResult;
    if (params.version) {
      const resolved = await resolveInstallVersion(params);
      detail = resolved.detail;
      version = resolved.version;
      official = isDefaultOfficialClawHubSkillSource({ baseUrl: params.baseUrl, detail });
      const trust = await ensureClawHubSkillTrustAcknowledged({
        ...params,
        version,
        skipClawHubTrustCheck: official,
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
      resolution = assertInstallResolutionAllowed(
        await fetchClawHubSkillInstallResolution({
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
          baseUrl: params.baseUrl,
          ...(params.forceInstall ? { forceInstall: true } : {}),
        }),
      );
      if (params.requestedReference) {
        if (
          resolution.installKind !== "github" ||
          resolution.trust?.state !== CLAWHUB_SKILLS_SH_TRUST_STATE
        ) {
          throw new Error(
            `Skill "${params.slug}" did not resolve to an unscanned, commit-pinned GitHub source.`,
          );
        }
        trustWarning = CLAWHUB_SKILLS_SH_TRUST_LABEL;
        params.logger?.warn?.(CLAWHUB_SKILLS_SH_TRUST_LABEL);
      }
      const resolutionOfficial = isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        resolution,
      });
      detail = resolutionOfficial
        ? undefined
        : await fetchDefaultClawHubSkillDetailIfOfficial({
            baseUrl: params.baseUrl,
            slug: params.slug,
            ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          });
      official = isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        detail,
        resolution,
      });
      if (resolution.installKind === "github") {
        version = resolution.github.commit;
        // GitHub-backed ClawHub skills are commit resolutions, not ClawHub skill
        // release versions; the install resolver owns their scan/force policy.
        params.logger?.info?.(`Downloading ${params.slug}@${version} from GitHub…`);
        archive = await downloadClawHubGitHubSkillArchive({
          repo: resolution.github.repo,
          commit: resolution.github.commit,
        });
      } else {
        version = resolution.archive.version;
        const trust = await ensureClawHubSkillTrustAcknowledged({
          ...params,
          version,
          skipClawHubTrustCheck: official,
        });
        if (!trust.ok) {
          return { ...trust, version };
        }
        trustWarning = trust.warning;
        params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
        archive = await downloadClawHubSkillArchiveUrl({
          url: resolution.archive.downloadUrl,
          baseUrl: params.baseUrl,
        });
      }
    }

    try {
      assertDownloadedArtifactIntegrity(archive, params.expectedIntegrity);
      if (!params.version && !resolution) {
        throw new Error(`Skill "${params.slug}" has no install resolution.`);
      }
      const install =
        resolution?.installKind === "github" && !params.version
          ? await installGitHubResolution({
              workspaceDir: params.workspaceDir,
              slug: params.slug,
              ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
              sourcePath: resolution.github.path,
              archivePath: archive.archivePath,
              registry,
              authority: official ? "official" : "third-party",
              repo: resolution.github.repo,
              commit: resolution.github.commit,
              requestedReference: params.requestedReference,
              trustState: params.trustState,
              force: params.force,
              logger: params.logger,
              config: params.config,
              onInstallPolicyWarning: params.onInstallPolicyWarning,
            })
          : await installArchiveResolution({
              workspaceDir: params.workspaceDir,
              slug: params.slug,
              ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
              version,
              archivePath: archive.archivePath,
              registry,
              authority: official
                ? "official"
                : isDefaultClawHubBaseUrl(params.baseUrl)
                  ? "openclaw"
                  : "third-party",
              force: params.force,
              logger: params.logger,
              config: params.config,
              onInstallPolicyWarning: params.onInstallPolicyWarning,
            });
      if (!install.ok) {
        return { ok: false, error: install.error };
      }

      const installedAt = Date.now();
      const artifact = buildDownloadedArtifactLock(archive);
      const fileTreeSha256 = await digestClawHubSkillTree(install.targetDir);
      const verificationVersion =
        resolution?.installKind === "github" && !params.version ? undefined : version;
      const [skillFile, verification] = await Promise.all([
        readInstalledSkillFileLock(install.targetDir),
        fetchInstallVerificationLock({
          slug: params.slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
          version: verificationVersion,
          baseUrl: params.baseUrl,
          logger: params.logger,
        }),
      ]);
      const sourceUrl =
        (resolution?.installKind === "github"
          ? normalizeOptionalStringValue(resolution.github.sourceUrl)
          : undefined) ?? readVerifiedClawHubSkillSourceUrl(verification?.provenance);
      const trackedMetadata = {
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        ...(params.trustState ? { trustState: params.trustState } : {}),
        installedAt,
        ...(sourceUrl ? { sourceUrl } : {}),
        artifact,
        ...(skillFile ? { skillFile } : {}),
        fileTreeSha256,
      };
      await writeClawHubSkillOrigin(install.targetDir, {
        version: 1,
        registry,
        slug: params.slug,
        ...trackedMetadata,
        installedVersion: version,
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[params.slug] = {
        version,
        registry,
        ...trackedMetadata,
        ...(verification ? { verification } : {}),
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);
      if (!params.clawManaged) {
        markClawPackageIndependentlyOwned({
          kind: "skill",
          source: "clawhub",
          ref: formatClawHubSkillRef(params),
          version,
          workspace: params.workspaceDir,
        });
      }
      await reportClawHubSkillInstallTelemetry({
        baseUrl: params.baseUrl,
        slug: params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        version,
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        ...(params.trustState ? { trustState: params.trustState } : {}),
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
    return { ok: false, error: formatClawHubSkillInstallError(err, params.slug) };
  }
}

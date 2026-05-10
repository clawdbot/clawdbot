import path from "node:path";
import type { ArchiveLogger } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { pathExists } from "../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installPackageDir } from "../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../infra/install-safe-path.js";
import {
  scanSkillInstallSource,
  type InstallSecurityScanResult,
} from "../plugins/install-security-scan.js";

const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS = ["SKILL.md"] as const;
export const CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS = [
  "SKILL.md",
  "skill.md",
  "skills.md",
  "SKILL.MD",
] as const;

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) > 0x7f) {
      return true;
    }
  }
  return false;
}

type SkillArchiveInstallScan =
  | false
  | {
      dangerouslyForceUnsafeInstall?: boolean;
      installId?: string;
      origin: string;
    };

export type SkillArchiveInstallResult =
  | { ok: true; targetDir: string }
  | { ok: false; error: string; failureKind: SkillArchiveInstallFailureKind };

export type SkillArchiveInstallFailureKind = "invalid-request" | "unavailable";

export function normalizeTrackedSkillSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function validateRequestedSkillSlug(raw: string): string {
  const slug = normalizeTrackedSkillSlug(raw);
  if (hasNonAscii(slug) || !VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function resolveWorkspaceSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}

function installFailure(
  error: string,
  failureKind: SkillArchiveInstallFailureKind,
): SkillArchiveInstallResult {
  return { ok: false, error, failureKind };
}

async function hasSkillArchiveRoot(
  rootDir: string,
  rootMarkers: readonly string[],
): Promise<boolean> {
  for (const candidate of rootMarkers) {
    if (await pathExists(path.join(rootDir, candidate))) {
      return true;
    }
  }
  return false;
}

function scanBlockedFailureKind(
  blocked: NonNullable<InstallSecurityScanResult["blocked"]>,
): SkillArchiveInstallFailureKind {
  return blocked.code === "security_scan_failed" ? "unavailable" : "invalid-request";
}

const TRANSIENT_ARCHIVE_ERROR_PATTERNS = [
  "enoent",
  "enospc",
  "eio",
  "eacces",
  "eperm",
  "ebusy",
  "emfile",
  "enfile",
  "timeout",
  "timed out",
] as const;

function archiveFailureKind(error: string): SkillArchiveInstallFailureKind {
  const lower = error.toLowerCase();
  if (lower.startsWith("failed to install skill:")) {
    return "unavailable";
  }
  for (const pattern of TRANSIENT_ARCHIVE_ERROR_PATTERNS) {
    if (lower.includes(pattern)) {
      return "unavailable";
    }
  }
  return "invalid-request";
}

export async function installExtractedSkillRoot(params: {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  timeoutMs?: number;
  logger?: ArchiveLogger;
  scan?: SkillArchiveInstallScan;
  rootMarkers?: readonly string[];
}): Promise<SkillArchiveInstallResult> {
  try {
    if (
      !(await hasSkillArchiveRoot(
        params.extractedRoot,
        params.rootMarkers ?? DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS,
      ))
    ) {
      return installFailure("archive is missing SKILL.md", "invalid-request");
    }
    let targetDir: string;
    try {
      targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    } catch (err) {
      return installFailure(formatErrorMessage(err), "invalid-request");
    }
    if (params.mode === "install" && (await pathExists(targetDir))) {
      return installFailure(
        `Skill already exists at ${targetDir}. Re-run with force/update.`,
        "invalid-request",
      );
    }

    if (params.scan) {
      const scanResult = await scanSkillInstallSource({
        dangerouslyForceUnsafeInstall: params.scan.dangerouslyForceUnsafeInstall,
        installId: params.scan.installId ?? "archive",
        logger: params.logger ?? {},
        origin: params.scan.origin,
        skillName: params.slug,
        sourceDir: params.extractedRoot,
      });
      if (scanResult?.blocked) {
        return installFailure(
          scanResult.blocked.reason,
          scanBlockedFailureKind(scanResult.blocked),
        );
      }
    }

    const install = await installPackageDir({
      sourceDir: params.extractedRoot,
      targetDir,
      mode: params.mode,
      timeoutMs: params.timeoutMs ?? 120_000,
      logger: params.logger,
      copyErrorPrefix: "failed to install skill",
      hasDeps: false,
      depsLogMessage: "",
    });
    if (!install.ok) {
      return installFailure(install.error, "unavailable");
    }
    return { ok: true, targetDir };
  } catch (err) {
    return installFailure(formatErrorMessage(err), "unavailable");
  }
}

export async function installSkillArchiveFromPath(params: {
  archivePath: string;
  workspaceDir: string;
  slug: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: ArchiveLogger;
  scan?: SkillArchiveInstallScan;
}): Promise<SkillArchiveInstallResult> {
  const result = await withExtractedArchiveRoot({
    archivePath: params.archivePath,
    tempDirPrefix: "openclaw-skill-archive-",
    timeoutMs: params.timeoutMs ?? 120_000,
    logger: params.logger,
    rootMarkers: ["SKILL.md"],
    onExtracted: async (rootDir) =>
      await installExtractedSkillRoot({
        workspaceDir: params.workspaceDir,
        slug: params.slug,
        extractedRoot: rootDir,
        mode: params.force ? "update" : "install",
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        scan: params.scan,
      }),
  });
  if (!result.ok) {
    const error = result.error.includes("unexpected archive layout")
      ? "archive is missing SKILL.md"
      : result.error;
    const failureKind =
      "failureKind" in result &&
      (result.failureKind === "invalid-request" || result.failureKind === "unavailable")
        ? result.failureKind
        : archiveFailureKind(error);
    return installFailure(error, failureKind);
  }
  return result;
}

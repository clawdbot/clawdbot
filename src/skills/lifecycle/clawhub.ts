// ClawHub lifecycle facade: public API plus install/update coordination.
import fs from "node:fs/promises";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  downloadClawHubSkillArchive,
  normalizeClawHubSha256Integrity,
} from "../../infra/clawhub-artifacts.js";
import type { ClawHubTrustErrorCode } from "../../infra/clawhub-install-trust.js";
import {
  CLAWHUB_SKILLS_SH_REF_PREFIX,
  fetchClawHubSkillVerification,
  type ClawHubSkillVerificationResponse,
} from "../../infra/clawhub-skills.js";
import { formatErrorMessage, isErrno } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { InstallSafetyOverrides } from "../../plugins/install-security-scan.types.js";
import { withClawPackageLifecycleLease } from "../../state/claw-package-lifecycle-lease.js";
import {
  normalizeTrackedSkillSlug,
  resolveWorkspaceSkillInstallDir,
  validateRequestedSkillSlug,
} from "./archive-install.js";
import {
  checkClawHubSkillTrust,
  isDefaultOfficialClawHubSkillSource,
  normalizeExpectedArtifactIntegrity,
  performClawHubSkillInstall,
  resolveInstallVersion,
  type ClawHubInstallParams,
  type InstallClawHubSkillResult,
  type Logger,
} from "./clawhub-install-core.js";
import { formatClawHubSkillRequestError } from "./clawhub-request-error.js";
import { resolveClawHubSkillStatusLinkSync } from "./clawhub-status.js";
import {
  parseRequestedClawHubSkillRef,
  readClawHubSkillOrigin,
  readClawHubSkillsLockfile,
  type ClawHubSkillRef,
  type ClawHubSkillsLockfile,
} from "./clawhub-store.js";
import {
  checkClawHubSkillPlanAtPath,
  planTrackedClawHubSkillState,
  type ClawHubSkillUninstallPlan,
} from "./clawhub-uninstall.js";

export { readVerifiedClawHubSkillSourceUrl } from "./clawhub-install-core.js";
export {
  readLocalSkillCardContentSync,
  resolveClawHubSkillStatusLinkSync,
  resolveClawHubSkillVerificationTarget,
  resolveLocalSkillCardStatusSync,
  searchSkillsFromClawHub,
  type ClawHubSkillStatusLink,
  type LocalSkillCardStatus,
} from "./clawhub-status.js";
export {
  readClawHubSkillsLockfileStatusSync,
  readTrackedClawHubSkillSlugs,
  untrackClawHubSkill,
  type ClawHubSkillsLockfileStatusRead,
} from "./clawhub-store.js";

export async function verifySkillWithClawHub(
  params: Parameters<typeof fetchClawHubSkillVerification>[0],
): Promise<Result<ClawHubSkillVerificationResponse, string>> {
  try {
    return ok(await fetchClawHubSkillVerification(params));
  } catch (error) {
    return resultError(
      formatClawHubSkillRequestError(error, { slug: params.slug, operation: "verify" }),
    );
  }
}

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
  | {
      ok: false;
      error: string;
      code?: ClawHubTrustErrorCode | "force_required";
      version?: string;
      warning?: string;
    };

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      ownerHandle?: string;
      requestedReference?: string;
      trustState?: ClawHubInstallParams["trustState"];
      baseUrl?: string;
      previousVersion: string | null;
    }
  | { ok: false; slug: string; error: string };

type ClawHubSkillInstallPreflightResult =
  | { ok: true; action: "install" | "reuse"; integrity: string; warning?: string }
  | { ok: false; code: string; error: string };

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const requested = params.requestedSlug.trim();
  const requestedRef =
    requested.startsWith("@") || requested.startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX)
      ? parseRequestedClawHubSkillRef(requested)
      : { slug: normalizeTrackedSkillSlug(requested) };
  const trackedSlug = requestedRef.slug;
  const trackedOrigin = await readClawHubSkillOrigin(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, trackedSlug),
  );
  const trackedLockEntry = params.lock.skills[trackedSlug];
  if (!trackedOrigin && !trackedLockEntry) {
    return validateRequestedSkillSlug(requestedRef.slug);
  }
  const trackedOwnerHandle = trackedOrigin?.ownerHandle ?? trackedLockEntry?.ownerHandle;
  if (requestedRef.ownerHandle && trackedOwnerHandle !== requestedRef.ownerHandle) {
    const trackedRef = trackedOwnerHandle ? `@${trackedOwnerHandle}/${trackedSlug}` : trackedSlug;
    throw new Error(
      `Skill "${trackedSlug}" is tracked as ${trackedRef}, not @${requestedRef.ownerHandle}/${trackedSlug}.`,
    );
  }
  const trackedRequestedReference =
    trackedOrigin?.requestedReference ?? trackedLockEntry?.requestedReference;
  if (
    requestedRef.requestedReference &&
    trackedRequestedReference !== requestedRef.requestedReference
  ) {
    throw new Error(
      `Skill "${trackedSlug}" is not tracked from ${requestedRef.requestedReference}.`,
    );
  }
  return trackedSlug;
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const ref = parseRequestedClawHubSkillRef(params.slug);
    if (ref.requestedReference && params.version) {
      throw new Error("--version is not supported for skills-sh references.");
    }
    return await performClawHubSkillInstall({
      ...params,
      slug: ref.slug,
      ...(ref.ownerHandle ? { ownerHandle: ref.ownerHandle } : {}),
      ...(ref.requestedReference ? { requestedReference: ref.requestedReference } : {}),
      ...(ref.trustState ? { trustState: ref.trustState } : {}),
    });
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
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
    return { ok: false, error: formatErrorMessage(err) };
  }
}

async function preflightSkillOwnerState(params: {
  workspaceDir: string;
  requested: ClawHubSkillRef;
  requestedLabel: string;
  version: string;
  integrity: string;
}): Promise<ClawHubSkillInstallPreflightResult> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.requested.slug);
  if (!(await pathExists(targetDir))) {
    return { ok: true, action: "install", integrity: params.integrity };
  }
  const status = resolveClawHubSkillStatusLinkSync({
    workspaceDir: params.workspaceDir,
    skillDir: targetDir,
    skillKey: params.requested.slug,
  });
  if (
    status?.status === "linked" &&
    status.installedVersion === params.version &&
    status.ownerHandle === params.requested.ownerHandle &&
    status.artifact?.integrity === params.integrity
  ) {
    return { ok: true, action: "reuse", integrity: params.integrity };
  }
  return {
    ok: false,
    code: "skill_version_conflict",
    error: `Skill ${params.requestedLabel}@${params.version} conflicts with the existing workspace skill at ${targetDir}.`,
  };
}

export async function preflightSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  logger?: Logger;
}): Promise<ClawHubSkillInstallPreflightResult> {
  try {
    const requested = parseRequestedClawHubSkillRef(params.slug);
    const resolved = await resolveInstallVersion({
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: params.version,
      baseUrl: params.baseUrl,
    });
    if (resolved.version !== params.version) {
      return {
        ok: false,
        code: "skill_version_resolution_mismatch",
        error: `Skill ${params.slug}@${params.version} resolved to ${resolved.version}.`,
      };
    }
    const trust = await checkClawHubSkillTrust({
      workspaceDir: params.workspaceDir,
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: resolved.version,
      baseUrl: params.baseUrl,
      logger: params.logger,
      skipClawHubTrustCheck: isDefaultOfficialClawHubSkillSource({
        baseUrl: params.baseUrl,
        detail: resolved.detail,
      }),
    });
    if (!trust.ok) {
      return {
        ok: false,
        code: trust.code ?? "skill_trust_required",
        error: trust.error,
      };
    }

    if (params.expectedIntegrity) {
      const integrity = normalizeExpectedArtifactIntegrity(params.expectedIntegrity);
      const owner = await preflightSkillOwnerState({
        workspaceDir: params.workspaceDir,
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        integrity,
      });
      return owner.ok && trust.warning ? { ...owner, warning: trust.warning } : owner;
    }

    const archive = await downloadClawHubSkillArchive({
      slug: requested.slug,
      ...(requested.ownerHandle ? { ownerHandle: requested.ownerHandle } : {}),
      version: resolved.version,
      baseUrl: params.baseUrl,
    });
    try {
      const integrity = normalizeClawHubSha256Integrity(archive.integrity);
      if (!integrity) {
        return {
          ok: false,
          code: "skill_integrity_unavailable",
          error: `Skill ${params.slug}@${params.version} did not resolve a valid artifact integrity.`,
        };
      }
      const owner = await preflightSkillOwnerState({
        workspaceDir: params.workspaceDir,
        requested,
        requestedLabel: params.slug,
        version: resolved.version,
        integrity,
      });
      return owner.ok && trust.warning ? { ...owner, warning: trust.warning } : owner;
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, code: "skill_preflight_failed", error: formatErrorMessage(err) };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  lock: ClawHubSkillsLockfile;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const origin = await readClawHubSkillOrigin(
    resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug),
  );
  const lockEntry = params.lock.skills[params.slug];
  if (!origin && !lockEntry) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  const ownerHandle = origin?.ownerHandle ?? lockEntry?.ownerHandle;
  const requestedReference = origin?.requestedReference ?? lockEntry?.requestedReference;
  const trustState = origin?.trustState ?? lockEntry?.trustState;
  return {
    ok: true,
    slug: params.slug,
    ...(ownerHandle ? { ownerHandle } : {}),
    ...(requestedReference ? { requestedReference } : {}),
    ...(trustState ? { trustState } : {}),
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? lockEntry?.version ?? null,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  expectedIntegrity?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  confirmInstall?: () => boolean | Promise<boolean>;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  /** True when a Claw lifecycle caller already owns package coordination. */
  clawManaged?: boolean;
}): Promise<InstallClawHubSkillResult> {
  if (params.clawManaged) {
    return await installRequestedSkillFromClawHub(params);
  }
  return await withClawPackageLifecycleLease(
    { kind: "skill", source: "clawhub", ref: params.slug, workspace: params.workspaceDir },
    () => installRequestedSkillFromClawHub(params),
  );
}

async function guardTrackedSkillLocalState(params: {
  workspaceDir: string;
  slug: string;
  previousVersion: string | null;
}): Promise<
  { ok: true; plan: ClawHubSkillUninstallPlan | undefined } | { ok: false; error: string }
> {
  const targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
  try {
    await fs.lstat(targetDir);
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      return { ok: true, plan: undefined };
    }
    return { ok: false, error: String(error) };
  }
  const local = await planTrackedClawHubSkillState({
    workspaceDir: params.workspaceDir,
    requestedRef: { slug: params.slug },
    expectedVersion: params.previousVersion ?? "",
  });
  if (local.ok) {
    return { ok: true, plan: local.plan };
  }
  return { ok: false, error: local.error };
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  force?: boolean;
  forceInstall?: boolean;
  logger?: Logger;
  config?: OpenClawConfig;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
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
      results.push({ ok: false, error: tracked.error });
      continue;
    }
    const install = await withClawPackageLifecycleLease(
      { kind: "skill", source: "clawhub", ref: tracked.slug, workspace: params.workspaceDir },
      async () => {
        let replaceBlocked: string | undefined;
        let localPlan: ClawHubSkillUninstallPlan | undefined;
        if (!params.force) {
          // Carry the verified digests into the install transaction. Re-resolving the
          // live path after download would leave another check-to-backup race.
          const local = await guardTrackedSkillLocalState({
            workspaceDir: params.workspaceDir,
            slug: tracked.slug,
            previousVersion: tracked.previousVersion,
          });
          if (!local.ok) {
            return {
              ok: false as const,
              code: "force_required" as const,
              error: `${local.error} Updating replaces the installed skill directory.`,
            };
          }
          localPlan = local.plan;
        }
        const installed = await installTrackedSkillFromClawHub({
          workspaceDir: params.workspaceDir,
          slug: tracked.slug,
          ...(tracked.ownerHandle ? { ownerHandle: tracked.ownerHandle } : {}),
          ...(tracked.requestedReference ? { requestedReference: tracked.requestedReference } : {}),
          ...(tracked.trustState ? { trustState: tracked.trustState } : {}),
          baseUrl: tracked.baseUrl,
          force: true,
          forceInstall: params.forceInstall,
          logger: params.logger,
          config: params.config,
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          ...(params.force
            ? {}
            : {
                onAfterBackup: async (backupDir: string) => {
                  const current = localPlan
                    ? await checkClawHubSkillPlanAtPath(localPlan, backupDir)
                    : {
                        ok: false as const,
                        error: `Skill ${JSON.stringify(tracked.slug)} appeared during update.`,
                      };
                  replaceBlocked = current.ok
                    ? undefined
                    : `${current.error} Updating replaces the installed skill directory.`;
                  return replaceBlocked;
                },
              }),
        });
        if (!installed.ok && replaceBlocked) {
          return { ok: false as const, code: "force_required" as const, error: replaceBlocked };
        }
        return installed;
      },
      { required: true },
    );
    results.push(
      install.ok
        ? {
            ok: true,
            slug: tracked.slug,
            previousVersion: tracked.previousVersion,
            version: install.version,
            changed: tracked.previousVersion !== install.version,
            targetDir: install.targetDir,
            ...(install.warning ? { warning: install.warning } : {}),
          }
        : install,
    );
  }
  return results;
}

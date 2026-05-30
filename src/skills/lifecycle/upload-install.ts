import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ArchiveLogger } from "../../infra/archive.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  installSkillArchiveFromPath,
  type SkillArchiveInstallFailureKind,
  validateRequestedSkillSlug,
} from "./archive-install.js";
import {
  defaultSkillUploadStore,
  normalizeSkillUploadSha256,
  SkillUploadRequestError,
  type SkillUploadStore,
} from "./upload-store.js";

export type UploadedSkillInstallErrorKind = "invalid-request" | "unavailable";

export const UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE =
  "Uploaded skill archive installs are disabled by skills.install.allowUploadedArchives";

export function areUploadedSkillArchivesEnabled(config: OpenClawConfig): boolean {
  return config.skills?.install?.allowUploadedArchives === true;
}

export type UploadedSkillInstallResult =
  | {
      ok: true;
      message: string;
      stdout: string;
      stderr: string;
      code: 0;
      slug: string;
      targetDir: string;
      sha256: string;
    }
  | {
      ok: false;
      error: string;
      errorKind: UploadedSkillInstallErrorKind;
    };

function uploadInstallFailureErrorKind(
  failureKind: SkillArchiveInstallFailureKind,
): UploadedSkillInstallErrorKind {
  return failureKind === "invalid-request" ? "invalid-request" : "unavailable";
}

export async function installUploadedSkillArchive(params: {
  uploadId: string;
  slug: string;
  force: boolean;
  sha256?: string;
  timeoutMs?: number;
  workspaceDir: string;
  config: OpenClawConfig;
  log?: ArchiveLogger;
  store?: SkillUploadStore;
}): Promise<UploadedSkillInstallResult> {
  const store = params.store ?? defaultSkillUploadStore;
  if (!areUploadedSkillArchivesEnabled(params.config)) {
    return {
      ok: false,
      error: UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE,
      errorKind: "unavailable",
    };
  }
  try {
    const requestedSlug = validateRequestedSkillSlug(params.slug);
    const requestedSha = normalizeSkillUploadSha256(params.sha256);
    return await store.withCommittedUpload(params.uploadId, async (record, upload) => {
      const rejectInvalid = async (error: string): Promise<UploadedSkillInstallResult> => {
        await upload.remove().catch(() => undefined);
        return { ok: false, error, errorKind: "invalid-request" };
      };
      if (record.kind !== "skill-archive") {
        return await rejectInvalid("unsupported upload kind");
      }
      if (record.slug !== requestedSlug) {
        return await rejectInvalid("install slug does not match upload slug");
      }
      if (record.force !== params.force) {
        return await rejectInvalid("install force does not match upload force");
      }
      if (requestedSha && requestedSha !== record.actualSha256) {
        return await rejectInvalid("install sha256 does not match uploaded archive");
      }
      if (!record.actualSha256) {
        return await rejectInvalid("committed upload is missing sha256");
      }

      const install = await installSkillArchiveFromPath({
        archivePath: record.archivePath,
        workspaceDir: params.workspaceDir,
        slug: record.slug,
        force: record.force,
        timeoutMs: params.timeoutMs,
        logger: params.log,
        scan: {
          installId: "upload",
          origin: "skill-upload",
        },
      });
      if (!install.ok) {
        const errorKind = uploadInstallFailureErrorKind(install.failureKind);
        if (install.failureKind === "invalid-request") {
          await upload.remove().catch(() => undefined);
        }
        return {
          ok: false,
          error: install.error,
          errorKind,
        };
      }
      await upload.remove().catch(() => undefined);
      return {
        ok: true,
        message: `Installed ${record.slug}`,
        stdout: "",
        stderr: "",
        code: 0,
        slug: record.slug,
        targetDir: install.targetDir,
        sha256: record.actualSha256,
      };
    });
  } catch (err) {
    if (err instanceof SkillUploadRequestError) {
      return {
        ok: false,
        error: err.message,
        errorKind: "invalid-request",
      };
    }
    const error = formatErrorMessage(err);
    if (error.startsWith("Invalid skill slug")) {
      return {
        ok: false,
        error,
        errorKind: "invalid-request",
      };
    }
    return {
      ok: false,
      error,
      errorKind: "unavailable",
    };
  }
}

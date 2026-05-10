import type { ValidateFunction } from "ajv";
import {
  installSkillArchiveFromPath,
  type SkillArchiveInstallFailureKind,
  validateRequestedSkillSlug,
} from "../../agents/skills-archive-install.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsUploadBeginParams,
  validateSkillsUploadChunkParams,
  validateSkillsUploadCommitParams,
} from "../protocol/index.js";
import type { ErrorShape } from "../protocol/index.js";
import {
  defaultSkillUploadStore,
  normalizeSkillUploadSha256,
  SkillUploadRequestError,
  type SkillUploadStore,
} from "./skills-upload-store.js";
import type { GatewayRequestContext } from "./types.js";
import type { GatewayRequestHandlers } from "./types.js";

type UploadInstallErrorCode = typeof ErrorCodes.INVALID_REQUEST | typeof ErrorCodes.UNAVAILABLE;

const UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE =
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
      errorCode: UploadInstallErrorCode;
    };

function uploadErrorShape(
  prefix: string,
  errors: Parameters<typeof formatValidationErrors>[0],
): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, `${prefix}: ${formatValidationErrors(errors)}`);
}

function mapUploadError(err: unknown): ErrorShape {
  if (err instanceof SkillUploadRequestError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, err.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err));
}

function uploadInstallFailureErrorCode(
  failureKind: SkillArchiveInstallFailureKind,
): UploadInstallErrorCode {
  return failureKind === "invalid-request" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
}

export const skillsUploadHandlers: GatewayRequestHandlers = {
  "skills.upload.begin": makeUploadHandler(
    "skills.upload.begin",
    validateSkillsUploadBeginParams,
    (params) => defaultSkillUploadStore.begin(params),
  ),
  "skills.upload.chunk": makeUploadHandler(
    "skills.upload.chunk",
    validateSkillsUploadChunkParams,
    (params) => defaultSkillUploadStore.chunk(params),
  ),
  "skills.upload.commit": makeUploadHandler(
    "skills.upload.commit",
    validateSkillsUploadCommitParams,
    (params) => defaultSkillUploadStore.commit(params),
  ),
};

function makeUploadHandler<P, R>(
  name: string,
  validator: ValidateFunction<P>,
  action: (params: P) => Promise<R>,
): GatewayRequestHandlers[string] {
  return async ({ params, respond, context }) => {
    if (!areUploadedSkillArchivesEnabled(context.getRuntimeConfig())) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE),
      );
      return;
    }
    if (!validator(params)) {
      respond(false, undefined, uploadErrorShape(`invalid ${name} params`, validator.errors));
      return;
    }
    try {
      respond(true, await action(params), undefined);
    } catch (err) {
      respond(false, undefined, mapUploadError(err));
    }
  };
}

export async function installUploadedSkillArchive(params: {
  uploadId: string;
  slug: string;
  force: boolean;
  sha256?: string;
  timeoutMs?: number;
  workspaceDir: string;
  context: GatewayRequestContext;
  store?: SkillUploadStore;
}): Promise<UploadedSkillInstallResult> {
  const store = params.store ?? defaultSkillUploadStore;
  if (!areUploadedSkillArchivesEnabled(params.context.getRuntimeConfig())) {
    return {
      ok: false,
      error: UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE,
      errorCode: ErrorCodes.UNAVAILABLE,
    };
  }
  try {
    const requestedSlug = validateRequestedSkillSlug(params.slug);
    const requestedSha = normalizeSkillUploadSha256(params.sha256);
    return await store.withCommittedUpload(params.uploadId, async (record, upload) => {
      const rejectInvalid = async (error: string): Promise<UploadedSkillInstallResult> => {
        await upload.remove().catch(() => undefined);
        return { ok: false, error, errorCode: ErrorCodes.INVALID_REQUEST };
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
        logger: params.context.logGateway,
        scan: {
          installId: "upload",
          origin: "skill-upload",
        },
      });
      if (!install.ok) {
        const errorCode = uploadInstallFailureErrorCode(install.failureKind);
        if (install.failureKind === "invalid-request") {
          await upload.remove().catch(() => undefined);
        }
        return {
          ok: false,
          error: install.error,
          errorCode,
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
        errorCode: ErrorCodes.INVALID_REQUEST,
      };
    }
    const error = formatErrorMessage(err);
    if (error.startsWith("Invalid skill slug")) {
      return {
        ok: false,
        error,
        errorCode: ErrorCodes.INVALID_REQUEST,
      };
    }
    return {
      ok: false,
      error,
      errorCode: ErrorCodes.UNAVAILABLE,
    };
  }
}

import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ProtocolValidator,
  validateSkillsUploadBeginParams,
  validateSkillsUploadChunkParams,
  validateSkillsUploadCommitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  areUploadedSkillArchivesEnabled,
  UPLOADED_SKILL_ARCHIVES_DISABLED_MESSAGE,
} from "../../skills/lifecycle/upload-install.js";
import {
  defaultSkillUploadStore,
  SkillUploadRequestError,
} from "../../skills/lifecycle/upload-store.js";
import type { GatewayRequestHandlers } from "./types.js";

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
  validator: ProtocolValidator<P>,
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

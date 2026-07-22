import { ErrorCodes } from "./gateway-error-details.js";
import type { ErrorShape } from "./schema/frames.js";

export type GatewayErrorMessageParam = string | number | boolean;

export type GatewayErrorLocalizationMetadata = {
  messageKey: string;
  messageParams?: Readonly<Record<string, GatewayErrorMessageParam>>;
};

export const GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS = {
  approvalNotFound: {
    code: ErrorCodes.INVALID_REQUEST,
    reason: ErrorCodes.APPROVAL_NOT_FOUND,
    messageKey: "gateway.approval.notFound",
  },
} as const;

const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/u;
const MAX_MESSAGE_KEY_LENGTH = 160;
const MAX_MESSAGE_PARAMS = 16;
const MAX_PARAM_KEY_LENGTH = 64;
const MAX_PARAM_STRING_LENGTH = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageParam(value: unknown): value is GatewayErrorMessageParam {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function readMessageParams(
  value: unknown,
): Readonly<Record<string, GatewayErrorMessageParam>> | null {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_MESSAGE_PARAMS) {
    return null;
  }
  const params: Record<string, GatewayErrorMessageParam> = {};
  for (const [key, param] of Object.entries(value)) {
    if (
      !key ||
      key.length > MAX_PARAM_KEY_LENGTH ||
      !isMessageParam(param) ||
      (typeof param === "string" && param.length > MAX_PARAM_STRING_LENGTH)
    ) {
      return null;
    }
    params[key] = param;
  }
  return Object.freeze(params);
}

/** Reads bounded localization metadata from an untrusted Gateway error payload. */
export function readGatewayErrorLocalization(
  error: Pick<ErrorShape, "details">,
): GatewayErrorLocalizationMetadata | null {
  if (!isRecord(error.details) || !isRecord(error.details.localization)) {
    return null;
  }
  const { messageKey, messageParams } = error.details.localization;
  if (
    typeof messageKey !== "string" ||
    messageKey.length > MAX_MESSAGE_KEY_LENGTH ||
    !MESSAGE_KEY_PATTERN.test(messageKey)
  ) {
    return null;
  }
  const params = readMessageParams(messageParams);
  if (!params) {
    return null;
  }
  return {
    messageKey,
    ...(messageParams === undefined ? {} : { messageParams: params }),
  };
}

/**
 * Adds bounded localization metadata inside the existing opaque details object.
 * The canonical English message remains present for old and untranslated clients.
 */
export function attachGatewayErrorLocalization(
  error: ErrorShape,
  localization: GatewayErrorLocalizationMetadata,
): ErrorShape {
  if (error.details !== undefined && !isRecord(error.details)) {
    throw new Error("Gateway error localization requires object-shaped details.");
  }
  if (isRecord(error.details) && "localization" in error.details) {
    throw new Error("Gateway error details already contain localization metadata.");
  }
  const validated = readGatewayErrorLocalization({
    details: { localization },
  });
  if (!validated) {
    throw new Error("Invalid Gateway error localization metadata.");
  }
  return {
    ...error,
    details: {
      ...error.details,
      localization: Object.freeze(validated),
    },
  };
}

/** Attaches metadata only to an explicitly reviewed stable discriminator tuple. */
export function attachKnownGatewayErrorLocalization(error: ErrorShape): ErrorShape {
  if (!isRecord(error.details) || "localization" in error.details) {
    return error;
  }
  const descriptor = GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS.approvalNotFound;
  if (error.code !== descriptor.code || error.details.reason !== descriptor.reason) {
    return error;
  }
  return attachGatewayErrorLocalization(error, { messageKey: descriptor.messageKey });
}

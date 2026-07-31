import { ErrorCodes } from "./gateway-error-details.js";
import type { ErrorShape } from "./schema/frames.js";

export const GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS = {
  approvalNotFound: {
    code: ErrorCodes.INVALID_REQUEST,
    reason: ErrorCodes.APPROVAL_NOT_FOUND,
    messageKey: "gateway.approval.notFound",
  },
} as const;

type GatewayErrorLocalizationDescriptor =
  (typeof GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS)[keyof typeof GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS];

export type GatewayErrorLocalizationMetadata = {
  messageKey: GatewayErrorLocalizationDescriptor["messageKey"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/**
 * Reads the complete shape of one owner-reviewed descriptor tuple from an
 * untrusted Gateway error. Unknown members and parameters fail closed.
 */
export function readGatewayErrorLocalization(error: {
  code?: string;
  details?: unknown;
}): GatewayErrorLocalizationMetadata | null {
  if (!isRecord(error.details) || !isRecord(error.details.localization)) {
    return null;
  }
  const localization = error.details.localization;
  if (!hasExactKeys(localization, ["messageKey"])) {
    return null;
  }
  const descriptor = GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS.approvalNotFound;
  if (
    error.code !== descriptor.code ||
    error.details.reason !== descriptor.reason ||
    localization.messageKey !== descriptor.messageKey
  ) {
    return null;
  }
  return Object.freeze({ messageKey: descriptor.messageKey });
}

/**
 * Adds exact localization metadata inside the existing opaque details object.
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
    code: error.code,
    details: { ...error.details, localization },
  });
  if (!validated) {
    throw new Error("Invalid Gateway error localization metadata.");
  }
  return {
    ...error,
    details: {
      ...error.details,
      localization: validated,
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

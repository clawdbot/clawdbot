import {
  attachKnownGatewayErrorLocalization,
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";

/** Builds the single owner-reviewed localized approval error descriptor. */
export function approvalNotFoundErrorShape(params: {
  message: "approval not found" | "unknown or expired approval id";
  remediation?: string;
}): ErrorShape {
  return attachKnownGatewayErrorLocalization(
    errorShape(ErrorCodes.INVALID_REQUEST, params.message, {
      details: {
        reason: ErrorCodes.APPROVAL_NOT_FOUND,
        ...(params.remediation ? { remediation: params.remediation } : {}),
      },
    }),
  );
}

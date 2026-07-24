import {
  GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS,
  readGatewayErrorLocalization,
  type GatewayErrorLocalizationMetadata,
} from "@openclaw/gateway-protocol";
import { GatewayRequestError } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";

type GatewayErrorLocalizationDescriptor =
  (typeof GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS)[keyof typeof GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS];

const RECOGNIZED_DESCRIPTORS = new Map<string, GatewayErrorLocalizationDescriptor>(
  Object.values(GATEWAY_ERROR_LOCALIZATION_DESCRIPTORS).map((descriptor) => [
    descriptor.messageKey,
    descriptor,
  ]),
);

type GatewayErrorTranslate = (key: string, params?: Record<string, string>) => string;
type GatewayErrorHasTranslation = (key: string) => boolean;

type ReviewedGatewayError = {
  error: GatewayRequestError;
  localization: GatewayErrorLocalizationMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function readReviewedGatewayError(error: unknown): ReviewedGatewayError | null {
  if (!(error instanceof GatewayRequestError) || !isRecord(error.details)) {
    return null;
  }
  const localization = readGatewayErrorLocalization({ details: error.details });
  if (!localization) {
    return null;
  }
  const descriptor = RECOGNIZED_DESCRIPTORS.get(localization.messageKey);
  if (
    !descriptor ||
    error.gatewayCode !== descriptor.code ||
    error.details.reason !== descriptor.reason
  ) {
    return null;
  }
  return { error, localization };
}

function renderReviewedGatewayError(
  reviewed: ReviewedGatewayError,
  translate: GatewayErrorTranslate,
  hasTranslation: GatewayErrorHasTranslation,
): string | null {
  if (!hasTranslation(reviewed.localization.messageKey)) {
    return null;
  }
  const params = reviewed.localization.messageParams
    ? Object.fromEntries(
        Object.entries(reviewed.localization.messageParams).map(([key, value]) => [
          key,
          String(value),
        ]),
      )
    : undefined;
  const localized = translate(reviewed.localization.messageKey, params);
  return localized && localized !== reviewed.localization.messageKey ? localized : null;
}

/** Localizes a reviewed descriptor or returns its canonical server English. */
export function resolveReviewedGatewayErrorMessage(
  error: unknown,
  translate: GatewayErrorTranslate = t,
  hasTranslation: GatewayErrorHasTranslation = (key) => i18n.hasTranslation(key),
): string | null {
  const reviewed = readReviewedGatewayError(error);
  if (!reviewed) {
    return null;
  }
  return (
    renderReviewedGatewayError(reviewed, translate, hasTranslation) ??
    fallbackErrorMessage(reviewed.error)
  );
}

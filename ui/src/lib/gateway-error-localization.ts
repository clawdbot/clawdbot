import {
  readGatewayErrorLocalization,
  type GatewayErrorLocalizationMetadata,
} from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../api/gateway.ts";
import { i18n, t } from "../i18n/index.ts";

type GatewayErrorTranslate = (key: string, params?: Record<string, string>) => string;
type GatewayErrorHasTranslation = (key: string) => boolean;

type ReviewedGatewayError = {
  error: GatewayRequestError;
  localization: GatewayErrorLocalizationMetadata;
};

function fallbackErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function readReviewedGatewayError(error: GatewayRequestError): ReviewedGatewayError | null {
  if (!isRecord(error.details)) {
    return null;
  }
  const localization = readGatewayErrorLocalization({
    code: error.gatewayCode,
    details: error.details,
  });
  return localization ? { error, localization } : null;
}

function renderReviewedGatewayError(
  reviewed: ReviewedGatewayError,
  translate: GatewayErrorTranslate,
  hasTranslation: GatewayErrorHasTranslation,
): string | null {
  if (!hasTranslation(reviewed.localization.messageKey)) {
    return null;
  }
  const localized = translate(reviewed.localization.messageKey);
  return localized && localized !== reviewed.localization.messageKey ? localized : null;
}

/** Localizes an exact reviewed descriptor or returns canonical Gateway English. */
export function resolveReviewedGatewayErrorMessage(
  error: unknown,
  translate: GatewayErrorTranslate = t,
  hasTranslation: GatewayErrorHasTranslation = (key) => i18n.hasTranslation(key),
): string | null {
  if (!(error instanceof GatewayRequestError)) {
    return null;
  }
  const reviewed = readReviewedGatewayError(error);
  if (!reviewed) {
    return fallbackErrorMessage(error);
  }
  return (
    renderReviewedGatewayError(reviewed, translate, hasTranslation) ?? fallbackErrorMessage(error)
  );
}

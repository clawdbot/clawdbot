import {
  readSystemAgentSessionInvalidatedErrorDetails,
  readSystemAgentInferenceUnavailableErrorDetails,
  type SystemAgentChatParams,
} from "@openclaw/gateway-protocol";
import { inferBasePathFromPathname, routeIdFromPath } from "../../app-route-paths.ts";

export type CustodianSessionVariant = "onboarding" | "new-agent" | "caretaker";

export function sessionVariant(
  onboarding: boolean,
  newAgentIntent: boolean,
): CustodianSessionVariant {
  return onboarding ? "onboarding" : newAgentIntent ? "new-agent" : "caretaker";
}

export function custodianChatParams(
  variant: CustodianSessionVariant,
  message?: string,
): Pick<SystemAgentChatParams, "welcomeVariant" | "message" | "context"> {
  const variantParams = variant === "caretaker" ? {} : { welcomeVariant: variant };
  if (message === undefined) {
    return variantParams;
  }
  const pathname = window.location.pathname;
  const page = routeIdFromPath(pathname, inferBasePathFromPathname(pathname));
  return { ...variantParams, message, ...(page ? { context: { page } } : {}) };
}

export function hasCustodianUserInput(params: SystemAgentChatParams): boolean {
  return (
    params.message !== undefined ||
    params.wizardAnswer !== undefined ||
    params.wizardCancel !== undefined
  );
}

export function custodianFailure(error: unknown): {
  inferenceUnavailable: boolean;
  sessionInvalidated: boolean;
} {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return {
    inferenceUnavailable: readSystemAgentInferenceUnavailableErrorDetails(details) !== undefined,
    sessionInvalidated: readSystemAgentSessionInvalidatedErrorDetails(details) !== undefined,
  };
}

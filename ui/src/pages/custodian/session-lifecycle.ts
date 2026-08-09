import {
  readSystemAgentSessionInvalidatedErrorDetails,
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

export function isCustodianSessionInvalidatedError(error: unknown): boolean {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return readSystemAgentSessionInvalidatedErrorDetails(details) !== undefined;
}

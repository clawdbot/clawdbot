import {
  readSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatParams,
} from "@openclaw/gateway-protocol";

export type CustodianSessionVariant = "onboarding" | "new-agent" | "caretaker";

export function sessionVariant(
  onboarding: boolean,
  newAgentIntent: boolean,
): CustodianSessionVariant {
  return onboarding ? "onboarding" : newAgentIntent ? "new-agent" : "caretaker";
}

export function welcomeVariant(
  variant: CustodianSessionVariant,
): Pick<SystemAgentChatParams, "welcomeVariant"> {
  return variant === "caretaker" ? {} : { welcomeVariant: variant };
}

export function isCustodianSessionInvalidatedError(error: unknown): boolean {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return readSystemAgentSessionInvalidatedErrorDetails(details) !== undefined;
}

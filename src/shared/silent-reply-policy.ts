import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";

export type SilentReplyPolicy = "allow" | "disallow";
export type SilentReplyConversationType = "direct" | "group" | "internal";
export type SilentReplyPolicyShape = Partial<
  Record<Exclude<SilentReplyConversationType, "direct">, SilentReplyPolicy>
>;

export const DEFAULT_SILENT_REPLY_POLICY: Record<SilentReplyConversationType, SilentReplyPolicy> = {
  direct: "disallow",
  group: "allow",
  internal: "allow",
};

export function classifySilentReplyConversationType(params: {
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
}): SilentReplyConversationType {
  if (params.conversationType) {
    return params.conversationType;
  }
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
  if (normalizedSessionKey.includes(":group:") || normalizedSessionKey.includes(":channel:")) {
    return "group";
  }
  if (normalizedSessionKey.includes(":direct:") || normalizedSessionKey.includes(":dm:")) {
    return "direct";
  }
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  if (normalizedSurface === "webchat") {
    return "direct";
  }
  return "internal";
}

export function resolveSilentReplyPolicyFromPolicies(params: {
  conversationType: SilentReplyConversationType;
  defaultPolicy?: SilentReplyPolicyShape;
  surfacePolicy?: SilentReplyPolicyShape;
}): SilentReplyPolicy {
  if (params.conversationType === "direct") {
    return "disallow";
  }
  return (
    params.surfacePolicy?.[params.conversationType] ??
    params.defaultPolicy?.[params.conversationType] ??
    DEFAULT_SILENT_REPLY_POLICY[params.conversationType]
  );
}

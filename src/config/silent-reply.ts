// Normalizes silent-reply config for channel response suppression.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
  type SilentReplyConversationType,
  type SilentReplyPolicy,
  type SilentReplyPolicyShape,
} from "../shared/silent-reply-policy.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type ResolveSilentReplyParams = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
};

function resolveSilentReplyConversationContext(params: ResolveSilentReplyParams): {
  conversationType: SilentReplyConversationType;
  defaultPolicy?: SilentReplyPolicyShape;
  surfacePolicy?: SilentReplyPolicyShape;
} {
  const conversationType = classifySilentReplyConversationType({
    sessionKey: params.sessionKey,
    surface: params.surface,
    conversationType: params.conversationType,
  });
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  // Surfaces are stored under normalized ids; keep explicit conversationType untouched.
  const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : undefined;
  return {
    conversationType,
    defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
    surfacePolicy: surface?.silentReply,
  };
}

/** Resolves the effective silent-reply settings for a routed conversation. */
export function resolveSilentReplySettings(params: ResolveSilentReplyParams): {
  policy: SilentReplyPolicy;
} {
  const context = resolveSilentReplyConversationContext(params);
  return {
    policy: resolveSilentReplyPolicyFromPolicies(context),
  };
}

/** Returns just the effective silent-reply policy for callers that do not need metadata. */
export function resolveSilentReplyPolicy(params: ResolveSilentReplyParams): SilentReplyPolicy {
  return resolveSilentReplySettings(params).policy;
}

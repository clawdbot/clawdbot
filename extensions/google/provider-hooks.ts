// Google provider module implements model/runtime integration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/core";
import type {
  ProviderFailoverErrorContext,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { resolveGoogleThinkingProfile } from "./provider-policy.js";
import { sanitizeGoogleThinkingPayload } from "./thinking-api.js";

// Google-family gRPC status codes stay with the shared Gemini provider hook.
function classifyGoogleFailoverCode(code: string | undefined) {
  switch (code?.trim().toUpperCase()) {
    case "UNAVAILABLE":
      return "overloaded" as const;
    case "DEADLINE_EXCEEDED":
      return "timeout" as const;
    case "INTERNAL":
      return "server_error" as const;
    default:
      return undefined;
  }
}

function wrapGoogleThinkingStream(ctx: ProviderWrapStreamFnContext) {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
    if (model.api !== "google-generative-ai" && model.api !== "google-vertex") {
      return;
    }
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: stripGoogleProviderPrefix(model.id).replace(/^models\//u, ""),
      thinkingLevel: ctx.thinkingLevel,
    });
  });
}

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...buildProviderToolCompatFamilyHooks("gemini"),
  resolveThinkingProfile: (context: ProviderDefaultThinkingPolicyContext) =>
    resolveGoogleThinkingProfile(context) satisfies ProviderThinkingProfile | undefined,
  wrapStreamFn: wrapGoogleThinkingStream,
  classifyFailoverReason: ({ code }: ProviderFailoverErrorContext) =>
    classifyGoogleFailoverCode(code),
};

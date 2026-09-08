// Fallback notice state helpers track fallback notices shown to users.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Only a matching recorded fallback transition needs runtime alias resolution.
// Reject absent or stale notices before that resolution can discover plugins.
export type FallbackNoticeState = Pick<SessionEntry, "fallbackNotice">;

export function resolveActiveFallbackState(params: {
  selectedModelRef: string;
  activeModelRef: string;
  config?: OpenClawConfig;
  state?: FallbackNoticeState;
}): { active: boolean; reason?: string } {
  const selected = normalizeOptionalString(params.state?.fallbackNotice?.selectedModel);
  const active = normalizeOptionalString(params.state?.fallbackNotice?.activeModel);
  const reason = normalizeOptionalString(params.state?.fallbackNotice?.reason);
  const fallbackActive =
    selected === params.selectedModelRef &&
    active === params.activeModelRef &&
    !areRuntimeModelRefsEquivalent(params.selectedModelRef, params.activeModelRef, {
      config: params.config,
    });
  return {
    active: fallbackActive,
    reason: fallbackActive ? reason : undefined,
  };
}

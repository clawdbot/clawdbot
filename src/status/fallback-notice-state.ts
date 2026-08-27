// Fallback notice state helpers track fallback notices shown to users.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Persisted fallback notice state is active only when the current selected and
// active runtime refs still match the recorded fallback transition.
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
    !areRuntimeModelRefsEquivalent(params.selectedModelRef, params.activeModelRef, {
      config: params.config,
    }) &&
    selected === params.selectedModelRef &&
    active === params.activeModelRef;
  return {
    active: fallbackActive,
    reason: fallbackActive ? reason : undefined,
  };
}

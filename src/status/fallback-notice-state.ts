import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type FallbackNoticeState = Pick<
  SessionEntry,
  "fallbackNoticeSelectedModel" | "fallbackNoticeActiveModel" | "fallbackNoticeReason"
>;

export function resolveActiveFallbackState(params: {
  selectedModelRef: string;
  activeModelRef: string;
  state?: FallbackNoticeState;
}): { active: boolean; reason?: string } {
  const selected = normalizeOptionalString(params.state?.fallbackNoticeSelectedModel);
  const active = normalizeOptionalString(params.state?.fallbackNoticeActiveModel);
  const reason = normalizeOptionalString(params.state?.fallbackNoticeReason);
  const fallbackActive =
    !areRuntimeModelRefsEquivalent(params.selectedModelRef, params.activeModelRef) &&
    selected === params.selectedModelRef &&
    active === params.activeModelRef;
  return {
    active: fallbackActive,
    reason: fallbackActive ? reason : undefined,
  };
}

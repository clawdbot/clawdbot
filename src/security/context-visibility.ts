// Applies security visibility policy to context and account data.
import type { ContextVisibilityMode } from "../config/types.base.js";

/** Supplemental context classes that can be hidden independently from the main message. */
export type ContextVisibilityKind = "history" | "thread" | "quote" | "forwarded";

/** Machine-readable reason for a supplemental context visibility decision. */
export type ContextVisibilityDecisionReason =
  /** Visibility mode includes all supplemental context. */
  | "mode_all"
  /** Sender allowlist includes the item source. */
  | "sender_allowed"
  /** Quote-only visibility mode permits quoted context even when sender is not allowed. */
  | "quote_override"
  /** Context was omitted by visibility mode or sender policy. */
  | "blocked";

/** Visibility decision returned to callers that need both the boolean result and audit reason. */
export type ContextVisibilityDecision = {
  /** Whether the supplemental context item should be included. */
  include: boolean;
  /** Rule that decided inclusion or omission. */
  reason: ContextVisibilityDecisionReason;
};

/** Evaluates one supplemental context item against mode, kind, and sender allowlist state. */
export function evaluateSupplementalContextVisibility(params: {
  /** Configured visibility mode for the current channel or default policy. */
  mode: ContextVisibilityMode;
  /** Supplemental context class being evaluated. */
  kind: ContextVisibilityKind;
  /** Whether the item source is permitted by the sender allowlist. */
  senderAllowed: boolean;
}): ContextVisibilityDecision {
  if (params.mode === "all") {
    return { include: true, reason: "mode_all" };
  }
  if (params.senderAllowed) {
    return { include: true, reason: "sender_allowed" };
  }
  if (params.mode === "allowlist_quote" && params.kind === "quote") {
    return { include: true, reason: "quote_override" };
  }
  // Fail closed: unknown or non-matching policy combinations must omit
  // supplemental context rather than leaking sender history/thread data.
  return { include: false, reason: "blocked" };
}

/** Boolean shorthand for callers that do not need the audit reason. */
export function shouldIncludeSupplementalContext(params: {
  /** Configured visibility mode for the current channel or default policy. */
  mode: ContextVisibilityMode;
  /** Supplemental context class being evaluated. */
  kind: ContextVisibilityKind;
  /** Whether the item source is permitted by the sender allowlist. */
  senderAllowed: boolean;
}): boolean {
  return evaluateSupplementalContextVisibility(params).include;
}

/** Filters supplemental context items and reports how many were omitted by visibility policy. */
export function filterSupplementalContextItems<T>(params: {
  /** Candidate supplemental context items in original delivery order. */
  items: readonly T[];
  /** Configured visibility mode for the current channel or default policy. */
  mode: ContextVisibilityMode;
  /** Shared supplemental context class for every candidate item. */
  kind: ContextVisibilityKind;
  /** Per-item allowlist predicate for the sender or source identity. */
  isSenderAllowed: (item: T) => boolean;
}): { items: T[]; omitted: number } {
  const items = params.items.filter((item) =>
    shouldIncludeSupplementalContext({
      mode: params.mode,
      kind: params.kind,
      senderAllowed: params.isSenderAllowed(item),
    }),
  );
  return {
    items,
    omitted: params.items.length - items.length,
  };
}

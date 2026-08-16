// Formats finalized message context into prompt-visible text.
import type { FinalizedRuntimeMsgContext } from "../templating.js";

/** Resolves normalized text for slash/bang command parsing. */
export function resolveCommandContextText(ctx: FinalizedRuntimeMsgContext): string {
  return ctx.commandText.trim();
}

/** Checks whether the inbound context carries an explicit command prefix. */
export function hasExplicitCommandContextText(ctx: FinalizedRuntimeMsgContext): boolean {
  const text = resolveCommandContextText(ctx);
  return text.startsWith("/") || text.startsWith("!");
}

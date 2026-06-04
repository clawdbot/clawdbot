// Formats finalized message context into prompt-visible text.
import type { FinalizedMsgContext } from "../templating.js";

/** Message context fields that can carry user-visible command text. */
export type ContextTextKey =
  | "BodyForAgent"
  | "BodyForCommands"
  | "CommandBody"
  | "RawBody"
  | "Body";

/** Returns the first string field from a finalized message context. */
export function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: readonly ContextTextKey[],
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/** Resolves normalized text for slash/bang command parsing. */
export function resolveCommandContextText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, ["BodyForCommands", "CommandBody", "RawBody", "Body"]).trim();
}

/** Checks whether the inbound context carries an explicit command prefix. */
export function hasExplicitCommandContextText(ctx: FinalizedMsgContext): boolean {
  const text = resolveCommandContextText(ctx);
  return text.startsWith("/") || text.startsWith("!");
}

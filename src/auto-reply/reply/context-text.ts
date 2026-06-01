import type { FinalizedMsgContext } from "../templating.js";

export type ContextTextKey =
  | "BodyForAgent"
  | "BodyForCommands"
  | "CommandBody"
  | "RawBody"
  | "Body";

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

export function resolveCommandContextText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, ["BodyForCommands", "CommandBody", "RawBody", "Body"]).trim();
}

export function hasExplicitCommandContextText(ctx: FinalizedMsgContext): boolean {
  const text = resolveCommandContextText(ctx);
  return text.startsWith("/") || text.startsWith("!");
}

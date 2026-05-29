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

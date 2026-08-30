import { isStringOption } from "../utils/string-readers.js";
import type { MsgContext } from "./templating.js";

type InternalTurnContext = Pick<
  MsgContext,
  "InternalTurnSource" | "Provider" | "Surface" | "OriginatingChannel"
>;

function legacyInternalTurnSource(value: string | undefined): MsgContext["InternalTurnSource"] {
  switch (value) {
    case "heartbeat":
      return "heartbeat";
    case "cron-event":
      return "cron";
    case "exec-event":
      return "exec";
    default:
      return undefined;
  }
}

/** Fold shipped SDK source labels at ingress; runtime channels describe transport only. */
export function normalizeInternalTurnContext(ctx: InternalTurnContext): void {
  const source = isStringOption(ctx.InternalTurnSource, ["heartbeat", "cron", "exec"] as const)
    ? ctx.InternalTurnSource
    : legacyInternalTurnSource(ctx.Provider);
  if (source) {
    ctx.InternalTurnSource = source;
  } else {
    delete ctx.InternalTurnSource;
  }
  for (const field of ["Provider", "Surface", "OriginatingChannel"] as const) {
    if (legacyInternalTurnSource(ctx[field])) {
      delete ctx[field];
    }
  }
}

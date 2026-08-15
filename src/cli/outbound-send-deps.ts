// CLI adapter for outbound sending dependencies used by message-style commands.
import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import type { CliDeps } from "./deps.types.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

export type { CliDeps } from "./deps.types.js";

/** Convert the broad CLI dependency bundle into the narrow outbound-send dependency shape. */
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}

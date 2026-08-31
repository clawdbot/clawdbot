import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { VoiceCallConfig } from "./config.js";
import type { CallRecord } from "./types.js";

/** Keep one agent owner for the full call, including legacy stored records. */
export function resolveCallAgentId(
  call: Pick<CallRecord, "agentId">,
  config: Pick<VoiceCallConfig, "agentId">,
): string {
  return normalizeAgentId(call.agentId ?? config.agentId);
}

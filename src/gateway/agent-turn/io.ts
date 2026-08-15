import type { RespondFn } from "../server-methods/shared-types.js";
import type { AgentTurnFrame, AgentTurnIo } from "./types.js";

export function createAgentTurnIo(respond: RespondFn): AgentTurnIo {
  const emit = (frame: AgentTurnFrame, meta?: Parameters<RespondFn>[3]) => {
    // Response order is positional, and final responses may outlive the handler.
    // Delegate synchronously while preserving the original three- or four-argument call.
    if (meta === undefined) {
      respond(...frame);
      return;
    }
    respond(...frame, meta);
  };
  return { emitAcceptance: emit, emitFinal: emit };
}

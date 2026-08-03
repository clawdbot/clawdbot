import type { AgentRuntimeSessionHandoffContext } from "../../gateway/agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import {
  type GatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { runWithGatewaySessionHandoffContext } from "./gateway-session-handoff-context.js";
import { callGatewayTool } from "./gateway.js";

/** Launch one derived agent run with source authority outside model-authored params. */
export async function callSessionHandoffAgent<T>(params: {
  request: CallGatewayOptions;
  authority: GatewayToolCallerIdentity;
  context: AgentRuntimeSessionHandoffContext;
}): Promise<T> {
  if (params.request.method !== "agent") {
    throw new Error("session handoff authority is valid only for agent runs");
  }
  return await withGatewayToolCallerIdentity(params.authority, () =>
    runWithGatewaySessionHandoffContext(params.context, () =>
      callGatewayTool<T>(
        "agent",
        { timeoutMs: params.request.timeoutMs ?? undefined },
        params.request.params,
        { requireAgentRuntimeIdentity: true, signal: params.request.signal },
      ),
    ),
  );
}

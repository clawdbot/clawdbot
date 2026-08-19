import type { AgentRuntimeSessionHandoffContext } from "../../gateway/agent-runtime-session-handoff.js";
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
  const requestParams = (params.request.params ?? {}) as Record<string, unknown>;
  const sessionKey =
    typeof requestParams.sessionKey === "string" ? requestParams.sessionKey.trim() : "";
  const runId =
    typeof requestParams.idempotencyKey === "string" ? requestParams.idempotencyKey.trim() : "";
  if (!sessionKey || !runId) {
    throw new Error("session handoff requires an exact target session and idempotency key");
  }
  const invoke = (extra: Parameters<typeof callGatewayTool<T>>[3]) =>
    withGatewayToolCallerIdentity(params.authority, () =>
      runWithGatewaySessionHandoffContext(params.context, () =>
        callGatewayTool<T>(
          "agent",
          { timeoutMs: params.request.timeoutMs ?? undefined },
          params.request.params,
          extra,
        ),
      ),
    );
  const extra = {
    requireAgentRuntimeIdentity: true,
    signal: params.request.signal,
    onSignalAbort: async (
      request: Parameters<NonNullable<CallGatewayOptions["onSignalAbort"]>>[0],
    ) => {
      await request("chat.abort", { sessionKey, runId }, { timeoutMs: 5_000 });
    },
  };
  if (params.request.expectFinal !== true) {
    return await invoke(extra);
  }

  return await new Promise<T>((resolve, reject) => {
    let accepted = false;
    const finalRequest = invoke({
      ...extra,
      expectFinal: true,
      onAccepted: (payload) => {
        accepted = true;
        resolve(payload as T);
      },
    });
    void finalRequest.then(
      (payload) => {
        if (!accepted) {
          resolve(payload);
        }
      },
      (error: unknown) => {
        // After acceptance, the outer agent.wait owns terminal projection. This
        // retained request exists only to keep exact-run cancellation armed.
        if (!accepted) {
          reject(error);
        }
      },
    );
  });
}

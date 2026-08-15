// Sends approval requests to the local approval socket service.
import type { ExecApprovalDecision } from "./exec-approvals-core.js";
import { requestJsonlSocket } from "./jsonl-socket.js";

export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) {
    return null;
  }
  const timeoutMs = params.timeoutMs ?? 15_000;
  const payload = JSON.stringify({
    type: "request",
    token,
    id: crypto.randomUUID(),
    request,
  });

  return await requestJsonlSocket({
    socketPath,
    requestLine: payload,
    timeoutMs,
    accept: (value) => {
      const msg = value as { type?: string; decision?: ExecApprovalDecision };
      if (msg?.type === "decision" && msg.decision) {
        return msg.decision;
      }
      return undefined;
    },
  });
}

import type {
  SessionsCreateParams,
  SessionsCreateResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type SessionCreateOutcome = {
  key: string;
  initialRun:
    | { status: "idle" }
    | { status: "started"; runId?: string; messageSeq?: number }
    | { status: "rejected"; error: string };
};

export type SessionCreateParams = SessionsCreateParams & {
  currentSessionKey?: string;
};

export function resolveSessionCreateParams(sessionKey = "", agentId?: string) {
  const normalizedSessionKey = sessionKey.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
    ...(parentSessionKey
      ? { parentSessionKey, emitCommandHooks: true, succeedsParent: false }
      : {}),
  };
}

export async function requestSessionCreate(
  client: Pick<GatewayBrowserClient, "request">,
  params: Omit<SessionCreateParams, "currentSessionKey"> = {},
): Promise<SessionCreateOutcome> {
  const result = await client.request<SessionsCreateResult>("sessions.create", params);
  const key = typeof result?.key === "string" ? result.key.trim() : "";
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  if (result.runStarted === true) {
    const runId = typeof result.runId === "string" ? result.runId.trim() : "";
    const messageSeq = result.messageSeq;
    return {
      key,
      initialRun: {
        status: "started",
        ...(runId ? { runId } : {}),
        ...(typeof messageSeq === "number" && Number.isSafeInteger(messageSeq) && messageSeq > 0
          ? { messageSeq }
          : {}),
      },
    };
  }
  if (result.runError !== undefined) {
    const message =
      typeof result.runError?.message === "string" ? result.runError.message.trim() : "";
    return {
      key,
      initialRun: {
        status: "rejected",
        error: message || "The session was created, but its first message could not be sent.",
      },
    };
  }
  return { key, initialRun: { status: "idle" } };
}

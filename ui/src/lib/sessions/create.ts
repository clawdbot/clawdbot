import { normalizeOptionalString as stringValue } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsCreateParams,
  SessionsCreateResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type SessionCreateOutcome = {
  key: string;
  entry?: Readonly<Record<string, unknown>>;
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
  const normalizedAgentId = agentId?.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
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
  const key = stringValue(result?.key) ?? "";
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  let initialRun: SessionCreateOutcome["initialRun"] = { status: "idle" };
  if (result.runStarted) {
    const runId = stringValue(result.runId) ?? "";
    const messageSeq = result.messageSeq;
    initialRun = {
      status: "started",
      ...(runId ? { runId } : {}),
      ...(typeof messageSeq === "number" && Number.isSafeInteger(messageSeq) && messageSeq > 0
        ? { messageSeq }
        : {}),
    };
  } else if (result.runError !== undefined) {
    const message = stringValue(result.runError?.message) ?? "";
    initialRun = {
      status: "rejected",
      error: message || "The session was created, but its first message could not be sent.",
    };
  }
  return { key, entry: result.entry, initialRun };
}

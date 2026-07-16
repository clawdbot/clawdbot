import type { SessionsCreateResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type SessionCreateOutcome = {
  key: string;
  initialRun: { status: "idle" } | { status: "started" } | { status: "rejected"; error: string };
};

export type SessionCreateParams = {
  key?: string;
  agentId?: string;
  catalogId?: string;
  currentSessionKey?: string;
  parentSessionKey?: string;
  fork?: boolean;
  label?: string;
  model?: string;
  thinkingLevel?: string;
  worktree?: boolean;
  /** Base ref for the managed worktree branch; requires worktree. */
  worktreeBaseRef?: string;
  /** Worktree name (branch becomes openclaw/<name>); requires worktree. */
  worktreeName?: string;
  /** Bind session exec to host=node with this node id (operator.admin). */
  execNode?: string;
  /** Absolute source checkout for the worktree (operator.admin). */
  cwd?: string;
  /** First message; the gateway creates the session and starts the run in one call. */
  message?: string;
  /** Attachments for the first message, using the chat.send wire format. */
  attachments?: unknown[];
  task?: string;
};

export function resolveSessionCreateParams(sessionKey = "", agentId?: string) {
  const normalizedSessionKey = sessionKey.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
    ...(parentSessionKey ? { parentSessionKey, emitCommandHooks: true } : {}),
  };
}

export async function requestSessionCreate(
  client: Pick<GatewayBrowserClient, "request">,
  params: Omit<SessionCreateParams, "currentSessionKey"> & { emitCommandHooks?: boolean } = {},
): Promise<SessionCreateOutcome> {
  const result = await client.request<SessionsCreateResult>("sessions.create", params);
  const key = typeof result?.key === "string" ? result.key.trim() : "";
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  if (result.runStarted === true) {
    return { key, initialRun: { status: "started" } };
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

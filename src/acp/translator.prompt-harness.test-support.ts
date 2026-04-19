import type { PromptRequest } from "@agentclientprotocol/sdk";
import { expect, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

export type PendingPromptHarness = {
  agent: AcpGatewayAgent;
  promptPromise: ReturnType<AcpGatewayAgent["prompt"]>;
  runId: string;
};

export const DEFAULT_SESSION_ID = "session-1";
export const DEFAULT_SESSION_KEY = "agent:main:main";
export const DEFAULT_PROMPT_TEXT = "hello";

export function createSessionAgentHarness(
  request: GatewayClient["request"],
  options: { sessionId?: string; sessionKey?: string; cwd?: string } = {},
) {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId,
    sessionKey,
    cwd: options.cwd ?? "/tmp",
  });
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });

  return {
    agent,
    sessionId,
    sessionKey,
    sessionStore,
  };
}

export function promptAgent(
  agent: AcpGatewayAgent,
  sessionId = DEFAULT_SESSION_ID,
  text = DEFAULT_PROMPT_TEXT,
) {
  return agent.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: {},
  } as unknown as PromptRequest);
}

export function observeSettlement(promise: ReturnType<AcpGatewayAgent["prompt"]>) {
  const settleSpy = vi.fn();
  void promise.then(
    (value) => settleSpy({ kind: "resolve", value }),
    (error) => settleSpy({ kind: "reject", error }),
  );
  return settleSpy;
}

export async function createPendingPromptHarness(): Promise<PendingPromptHarness> {
  let runId: string | undefined;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chat.send") {
      runId = params?.idempotencyKey as string | undefined;
      return new Promise<never>(() => {});
    }
    return {};
  }) as GatewayClient["request"];

  const { agent, sessionId } = createSessionAgentHarness(request);
  const promptPromise = promptAgent(agent, sessionId);

  await vi.waitFor(() => {
    expect(runId).toBeDefined();
  });

  return {
    agent,
    promptPromise,
    runId: runId!,
  };
}

export function createChatEvent(payload: Record<string, unknown>): EventFrame {
  return {
    type: "event",
    event: "chat",
    payload,
  } as EventFrame;
}

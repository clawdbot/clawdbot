/** Shared ACP translator bridge request/event fixtures and assertions. */
import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expect, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

/** Builds a minimal ACP new-session request for translator tests. */
export function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

/** Builds a minimal ACP load-session request for translator tests. */
export function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

/** Builds a minimal ACP prompt request for translator tests. */
export function createPromptRequest(
  sessionId: string,
  text: string,
  meta: Record<string, unknown> = {},
): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: meta,
  } as unknown as PromptRequest;
}

/** Builds a minimal ACP set-session-mode request for translator tests. */
export function createSetSessionModeRequest(
  sessionId: string,
  modeId: string,
): SetSessionModeRequest {
  return {
    sessionId,
    modeId,
    _meta: {},
  } as unknown as SetSessionModeRequest;
}

/** Builds a minimal ACP set-session-config-option request for translator tests. */
export function createSetSessionConfigOptionRequest(
  sessionId: string,
  configId: string,
  value: string | boolean,
): SetSessionConfigOptionRequest {
  return {
    sessionId,
    configId,
    value,
    _meta: {},
  } as unknown as SetSessionConfigOptionRequest;
}

/** Builds a Gateway tool event fixture for translator tests. */
export function createToolEvent(params: {
  sessionKey: string;
  phase: "start" | "update" | "result";
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}): EventFrame {
  return {
    event: "agent",
    payload: {
      sessionKey: params.sessionKey,
      stream: "tool",
      data: {
        phase: params.phase,
        toolCallId: params.toolCallId,
        name: params.name,
        args: params.args,
        partialResult: params.partialResult,
        result: params.result,
        isError: params.isError,
      },
    },
  } as unknown as EventFrame;
}

/** Builds a Gateway final chat event fixture for translator tests. */
export function createChatFinalEvent(sessionKey: string): EventFrame {
  return {
    event: "chat",
    payload: {
      sessionKey,
      state: "final",
    },
  } as unknown as EventFrame;
}

export async function expectOversizedPromptRejected(params: { sessionId: string; text: string }) {
  const requestMock = vi.fn(async (_method: string) => ({ ok: true }));
  const request = requestMock as GatewayClient["request"];
  const sessionStore = createInMemorySessionStore();
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
  await agent.loadSession(createLoadSessionRequest(params.sessionId));

  await expect(agent.prompt(createPromptRequest(params.sessionId, params.text))).rejects.toThrow(
    /maximum allowed size/i,
  );
  expect(requestMock.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  const session = sessionStore.getSession(params.sessionId);
  expect(session?.activeRunId).toBeNull();
  expect(session?.abortController).toBeNull();

  sessionStore.clearAllSessionsForTest();
}

export type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

export function configOptions(value: unknown) {
  expect(Array.isArray(value), "config options").toBe(true);
  return value as Array<Record<string, unknown>>;
}

export function expectConfigOption(options: unknown, id: string, fields: Record<string, unknown>) {
  const option = configOptions(options).find((candidate) => candidate.id === id);
  if (!option) {
    throw new Error(`Expected config option ${id}`);
  }
  for (const [field, value] of Object.entries(fields)) {
    expect(option[field]).toEqual(value);
  }
}

export function sessionUpdatePayloads(source: MockCallSource, updateType?: string) {
  const payloads = source.mock.calls.map((call, index) => {
    const envelope = requireRecord(call[0], `session update envelope ${index}`);
    return {
      sessionId: envelope.sessionId,
      update: requireRecord(envelope.update, `session update ${index}`),
    };
  });
  if (!updateType) {
    return payloads;
  }
  return payloads.filter((payload) => payload.update.sessionUpdate === updateType);
}

export function expectSessionUpdate(source: MockCallSource, sessionId: string, updateType: string) {
  const update = sessionUpdatePayloads(source, updateType).find(
    (payload) => payload.sessionId === sessionId,
  )?.update;
  if (!update) {
    throw new Error(`expected ${sessionId} ${updateType}`);
  }
  return update;
}

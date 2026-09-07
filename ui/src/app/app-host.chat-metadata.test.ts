/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  invalidateChatMetadataStore,
  peekChatMetadata,
  beginChatMetadataPublication,
  type ChatMetadataResult,
} from "../lib/chat/chat-metadata-store.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  applySelectedChatAgent,
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "../pages/chat/chat-state-refresh.ts";
import "./app-host.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";

type ChatMetadataShell = HTMLElement & {
  runtime: { context: ApplicationContext };
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
  synchronizeGateway: (snapshot: ApplicationGatewaySnapshot) => void;
};

afterEach(() => {
  vi.useRealTimers();
});

it.each(["config.changed", "chat.metadata.changed"])(
  "refreshes the retained pane after repair without changing conversation state (%s)",
  async (event) => {
    const model = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" };
    let ready = false;
    const request = vi.fn(async (): Promise<ChatMetadataResult> => ({
      commands: [],
      models: [
        {
          ...model,
          available: ready,
          ...(ready ? {} : { unavailableReason: "missing-auth" as const }),
        },
      ],
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const state = {
      client,
      connected: true,
      connectionEpoch: 1,
      sessionKey: "agent:main:current",
      chatModelCatalog: [],
      chatModelsLoading: false,
      chatModelCatalogError: null,
      chatMessages: [],
      chatQueue: [],
      chatRunId: null,
      chatMessage: "Keep this draft",
      chatError: "No route-compatible authentication source is configured",
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const messages = state.chatMessages;
    const queue = state.chatQueue;
    const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
    shell.runtime = {
      context: {
        gateway: { snapshot: { client, phase: "connected" } },
        agents: { state: { agentsList: null }, refreshList: vi.fn(async () => null) },
        agentSelection: { state: { selectedId: "main" } },
        runtimeConfig: {
          state: { configFormDirty: false, configSnapshot: null },
          ensureLoaded: vi.fn(async () => null),
          refresh: vi.fn(async () => null),
        },
      } as unknown as ApplicationContext,
    };
    try {
      await refreshChatMetadata(state);
      expect(state.chatModelCatalog[0]?.available).toBe(false);
      const pending = createDeferred<{
        commands: never[];
        models: typeof state.chatModelCatalog;
      }>();
      request.mockImplementationOnce(() => pending.promise);
      shell.handleGatewayEvent({ event, payload: {} });
      expect(state.chatModelCatalog[0]?.available).toBe(false);
      pending.resolve({
        commands: [],
        models: [{ ...model, available: false, unavailableReason: "auth-failed" }],
      });
      await vi.waitFor(() =>
        expect(state.chatModelCatalog[0]?.unavailableReason).toBe("auth-failed"),
      );
      request.mockRejectedValueOnce(new Error("metadata transport failed"));
      shell.handleGatewayEvent({ event, payload: {} });
      await vi.waitFor(() =>
        expect(state.chatModelCatalogError).toContain("metadata transport failed"),
      );
      expect(state.chatModelCatalog[0]?.available).toBe(false);
      ready = true;
      shell.handleGatewayEvent({ event, payload: {} });
      await vi.waitFor(() => expect(state.chatModelCatalog[0]?.available).toBe(true));
      expect(state.chatMessage).toBe("Keep this draft");
      expect(state.chatError).toBe("No route-compatible authentication source is configured");
      expect(state.chatMessages).toBe(messages);
      expect(state.chatQueue).toBe(queue);
      expect(state.chatRunId).toBeNull();
      expect(request.mock.calls).toHaveLength(4);
    } finally {
      retireChatMetadataRequests(state);
    }
  },
);

it("invalidates chat metadata on config changes and same-client disconnects", () => {
  vi.useFakeTimers();
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const connected = {
    client,
    phase: "connected",
    sessionKey: "agent:main:main",
  } as ApplicationGatewaySnapshot;
  const connectionBootstrap = {
    reset: vi.fn(),
    run: (_key: string, task: () => Promise<unknown>) => task(),
    synchronize: vi.fn(),
  };
  const context = {
    gateway: { snapshot: connected },
    connectionBootstrap,
    runtimeConfig: {
      state: { configFormDirty: false, configSnapshot: null },
      ensureLoaded: vi.fn(async () => null),
      refresh: vi.fn(async () => null),
    },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = { context };

  shell.synchronizeGateway(connected);
  beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [], models: [] });
  shell.handleGatewayEvent({ event: "config.changed", payload: {} });
  expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();

  beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [], models: [] });
  shell.synchronizeGateway({ ...connected, phase: "reconnecting" });
  expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();
});

it("rebinds global chat metadata immediately on agent selection and follows later invalidation", async () => {
  const model = { id: "model", name: "Model", provider: "openai" };
  let ready = false;
  const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
    commands: [],
    models: [{ ...model, available: params?.agentId === "main" && ready }],
  }));
  const client = { request } as unknown as GatewayBrowserClient;
  const state = makeChatHost({ client }) as ChatPageHost;
  state.connected = true;
  state.sessionKey = "global";
  state.assistantAgentId = "work";
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  state.chatMessage = "Keep this draft";
  state.chatError = "Keep this error";
  const messages = state.chatMessages;
  try {
    await refreshChatMetadata(state);
    expect(state.chatModelCatalog[0]?.available).toBe(false);
    applySelectedChatAgent(state, "main");
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.metadata", {
        agentId: "main",
        sessionKey: "global",
      }),
    );
    ready = true;
    invalidateChatMetadataStore(client);
    await vi.waitFor(() => expect(state.chatModelCatalog[0]?.available).toBe(true));
    expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(3);
    expect(state.chatMessage).toBe("Keep this draft");
    expect(state.chatError).toBe("Keep this error");
    expect(state.chatMessages).toBe(messages);
  } finally {
    retireChatMetadataRequests(state);
  }
});

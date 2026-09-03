/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { peekChatMetadata, beginChatMetadataPublication } from "../lib/chat/chat-metadata-store.ts";
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
  beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [] });
  shell.handleGatewayEvent({ event: "config.changed", payload: {} });
  expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();

  beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [] });
  shell.synchronizeGateway({ ...connected, phase: "reconnecting" });
  expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();
});

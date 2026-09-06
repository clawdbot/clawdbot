import { createServer, type ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import * as subscriptions from "./server-runtime-subscriptions.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("binds a first native chat.send before streaming and persists its stopped partial", async () => {
  const state = await createOpenClawTestState({
    label: "first-turn-binding",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
  const runId = "first-native-turn";
  const sessionKey = "agent:main:first-turn-binding";
  const partial = "This is the first native assistant partial.";
  const providerResponse = createDeferred<ServerResponse>();
  const providerClosed = createDeferred();
  const firstDelta = createDeferred();
  const terminal = createDeferred();
  const requestBodies: string[] = [];
  // Call-through observation exposes the real Gateway-owned buffer and registration.
  const observeSubscriptions = vi.spyOn(subscriptions, "startGatewayEventSubscriptions");
  const providerServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.once("close", () => providerClosed.resolve());
      providerResponse.resolve(response);
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let original: ChatAbortControllerEntry | undefined;
  const lifecycle: Array<{ phase?: unknown; sessionId?: unknown; aborted?: unknown }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      throw new Error("mock provider did not bind");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "first-turn",
    );
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      tools: { profile: "minimal" },
      gateway: { auth: { mode: "token", token: "first-turn-test" } },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: "first-turn-test",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        const payload = event.payload as
          | {
              runId?: string;
              state?: string;
              stream?: string;
              sessionId?: string;
              data?: { phase?: string; aborted?: boolean };
            }
          | undefined;
        if (payload?.runId !== runId) {
          return;
        }
        if (event.event === "chat" && payload.state === "delta") {
          firstDelta.resolve();
        }
        if (event.event === "chat" && payload.state === "aborted") {
          terminal.resolve();
        }
        if (event.event === "agent" && payload.stream === "lifecycle") {
          lifecycle.push({ ...payload.data, sessionId: payload.sessionId });
        }
      },
    });
    const runtime = observeSubscriptions.mock.calls.at(-1)?.[0];
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error("Gateway subscriptions were not started");
    }
    expect(loadExactSessionEntryReadOnly({ sessionKey })?.entry).toBeUndefined();
    await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
    expect(
      await gateway.client.request("chat.send", {
        sessionKey,
        message: "Start a reply and wait for Stop.",
        idempotencyKey: runId,
      }),
    ).toMatchObject({ runId, status: "started" });
    const response = await providerResponse.promise;
    original = runtime.chatAbortControllers.get(runId);
    expect(original).toBeDefined();
    const committed = loadExactSessionEntryReadOnly({ sessionKey });
    expect(committed?.entry.sessionId).toBeDefined();
    if (!original || !committed) {
      throw new Error("Native initialization did not retain its registration and session");
    }
    expect(committed.entry.sessionId).not.toBe(runId);
    expect.soft(original.sessionId).toBe(committed.entry.sessionId);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "first-message",
          role: "assistant",
          content: [],
          status: "in_progress",
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "first-message",
        output_index: 0,
        content_index: 0,
        delta: partial,
      },
    ]) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    await firstDelta.promise;
    expect(runtime.chatRunState.resolveBuffer(runId).text).toBe(partial);
    expect.soft(original.sessionId).toBe(committed.entry.sessionId);
    expect(lifecycle).toContainEqual(
      expect.objectContaining({ phase: "start", sessionId: committed.entry.sessionId }),
    );
    const stop = await gateway.client
      .request("chat.send", {
        sessionKey,
        message: "/stop",
        idempotencyKey: "stop-first-native-turn",
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    expect.soft(stop).toMatchObject({ result: { ok: true, aborted: true, runIds: [runId] } });
    expect(original.controller.signal.aborted).toBe(true);
    await terminal.promise;
    await providerClosed.promise;
    await vi.waitFor(() => expect(runtime.chatAbortControllers.has(runId)).toBe(false));
    expect
      .soft(loadExactSessionEntryReadOnly({ sessionKey })?.entry, JSON.stringify(lifecycle))
      .toMatchObject({
        sessionId: committed.entry.sessionId,
        status: "killed",
        abortedLastRun: true,
      });
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        phase: "end",
        status: "cancelled",
        aborted: true,
        stopReason: "stop",
        sessionId: committed.entry.sessionId,
      }),
    );
    const events = await loadTranscriptEvents({
      sessionKey,
      sessionId: committed.entry.sessionId,
      agentId: "main",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: partial }],
          openclawAbort: { aborted: true, origin: "stop-command", runId },
        }),
      }),
    );
    expect(requestBodies).toHaveLength(1);
  } finally {
    original?.controller.abort();
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      providerServer.close(() => resolve());
    });
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "first-turn binding test cleanup" });
      }
    } finally {
      observeSubscriptions.mockRestore();
      await state.cleanup();
    }
  }
});

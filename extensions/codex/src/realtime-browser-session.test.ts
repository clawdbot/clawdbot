import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { registerRealtimeVoiceBrowserSessionBroker } from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./app-server/client.js";
import type { CodexServerNotification } from "./app-server/protocol.js";
import {
  CODEX_REALTIME_OFFER_PATH,
  createCodexRealtimeBrowserSessionBroker,
} from "./realtime-browser-session.js";

const sharedClientMocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  releaseClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getClient,
  releaseLeasedSharedCodexAppServerClient: sharedClientMocks.releaseClient,
}));

function createSdpRequest(token: string): IncomingMessage {
  return Object.assign(Readable.from(["v=offer\r\n"]), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/sdp",
    },
  }) as unknown as IncomingMessage;
}

function createResponseHarness(options: { autoFinish?: boolean } = {}): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  readBody: () => string;
  close: () => void;
} {
  let body = "";
  const end = vi.fn((value?: string) => {
    body = value ?? "";
    if (options.autoFinish !== false) {
      queueMicrotask(() => res.emit("finish"));
    }
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: vi.fn(),
    end,
  }) as unknown as ServerResponse;
  return {
    res,
    end,
    readBody: () => body,
    close: () => {
      res.emit("close");
    },
  };
}

function createFakeClient(options: { stallRealtimeStart?: boolean } = {}): {
  client: CodexAppServerClient;
  methods: string[];
  readRealtimeStartSignal: () => AbortSignal | undefined;
} {
  let notificationHandler: ((notification: CodexServerNotification) => void) | undefined;
  let realtimeStartSignal: AbortSignal | undefined;
  const methods: string[] = [];
  const client = {
    request: vi.fn(
      async (method: string, _params?: unknown, requestOptions?: { signal?: AbortSignal }) => {
        methods.push(method);
        if (method === "thread/start") {
          return {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            cwd: "/tmp/workspace",
            model: "gpt-5.4",
            modelProvider: "openai",
            sandbox: { type: "readOnly" },
            thread: {
              id: "thread-1",
              sessionId: "session-1",
              cliVersion: "0.145.0",
              createdAt: 1,
              updatedAt: 1,
              cwd: "/tmp/workspace",
              ephemeral: true,
              modelProvider: "openai",
              preview: "",
              source: "appServer",
              status: { type: "idle" },
              turns: [],
            },
          };
        }
        if (method === "thread/realtime/start") {
          realtimeStartSignal = requestOptions?.signal;
          if (options.stallRealtimeStart) {
            return await new Promise((_, reject) => {
              const signal = requestOptions?.signal;
              const rejectAbort = () =>
                reject(
                  signal?.reason instanceof Error
                    ? signal.reason
                    : new Error("realtime start aborted"),
                );
              signal?.addEventListener("abort", rejectAbort, { once: true });
              if (signal?.aborted) {
                rejectAbort();
              }
            });
          }
          queueMicrotask(() => {
            notificationHandler?.({
              method: "thread/realtime/sdp",
              params: { threadId: "thread-1", sdp: "v=answer\r\n" },
            });
          });
          return {};
        }
        if (method === "thread/realtime/stop" || method === "thread/unsubscribe") {
          return {};
        }
        throw new Error(`Unexpected Codex request: ${method}`);
      },
    ),
    addNotificationHandler: vi.fn((handler: (notification: CodexServerNotification) => void) => {
      notificationHandler = handler;
      return () => {
        notificationHandler = undefined;
      };
    }),
  } as unknown as CodexAppServerClient;
  return {
    client,
    methods,
    readRealtimeStartSignal: () => realtimeStartSignal,
  };
}

describe("Codex OAuth realtime browser session", () => {
  beforeEach(() => {
    sharedClientMocks.getClient.mockReset();
    sharedClientMocks.releaseClient.mockReset();
  });

  it("redeems browser reservations once and invalidates pending ones on cleanup", async () => {
    const fake = createFakeClient();
    sharedClientMocks.getClient.mockResolvedValue(fake.client);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getPluginConfig: () => ({}),
    });
    const unregister = registerRealtimeVoiceBrowserSessionBroker(realtime.broker);
    expect(realtime.broker.capabilities).toEqual({
      transports: ["webrtc"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsVideoFrames: false,
    });
    const first = await realtime.broker.createBrowserSession({
      providerConfig: {},
      instructions: " Keep the same Talk persona. ",
      model: " gpt-realtime-2 ",
      voice: " Marin ",
      initialItems: [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ],
    });
    const second = await realtime.broker.createBrowserSession({ providerConfig: {} });
    const cancelled = await realtime.broker.createBrowserSession({ providerConfig: {} });

    expect(first).toMatchObject({
      provider: "openai",
      transport: "webrtc",
      offerUrl: CODEX_REALTIME_OFFER_PATH,
      voice: "Marin",
      clientSecret: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
      expiresAt: expect.any(Number),
    });
    expect(first).not.toHaveProperty("model");
    if (first.transport !== "webrtc" || second.transport !== "webrtc") {
      throw new Error("Expected Codex browser sessions to use WebRTC");
    }
    expect(second.clientSecret).not.toBe(first.clientSecret);
    await realtime.broker.cancelBrowserSession?.(cancelled);

    try {
      const accepted = createResponseHarness();
      await expect(
        realtime.handler(createSdpRequest(first.clientSecret), accepted.res),
      ).resolves.toBe(true);
      expect(accepted.res.statusCode).toBe(200);
      expect(accepted.readBody()).toBe("v=answer\r\n");
      const threadStartParams = (fake.client.request as ReturnType<typeof vi.fn>).mock.calls.find(
        ([method]) => method === "thread/start",
      )?.[1];
      expect(threadStartParams).toEqual({
        cwd: process.cwd(),
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { "features.realtime_conversation": true },
      });
      const realtimeStartParams = (fake.client.request as ReturnType<typeof vi.fn>).mock.calls.find(
        ([method]) => method === "thread/realtime/start",
      )?.[1];
      expect(realtimeStartParams).toEqual({
        threadId: "thread-1",
        outputModality: "audio",
        transport: { type: "webrtc", sdp: "v=offer\r\n" },
        version: "v3",
        includeStartupContext: true,
        voice: "Marin",
        initialItems: [
          { role: "developer", text: "Keep the same Talk persona." },
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
        ],
      });
      expect(realtimeStartParams).not.toHaveProperty("prompt");
      expect(realtimeStartParams).not.toHaveProperty("model");

      const replayed = createResponseHarness();
      await expect(
        realtime.handler(createSdpRequest(first.clientSecret), replayed.res),
      ).resolves.toBe(true);
      expect(replayed.res.statusCode).toBe(401);
      expect(sharedClientMocks.getClient).toHaveBeenCalledTimes(1);

      if (cancelled.transport !== "webrtc") {
        throw new Error("Expected cancelled Codex browser session to use WebRTC");
      }
      const cancelledResponse = createResponseHarness();
      await expect(
        realtime.handler(createSdpRequest(cancelled.clientSecret), cancelledResponse.res),
      ).resolves.toBe(true);
      expect(cancelledResponse.res.statusCode).toBe(401);

      await realtime.cleanup();
      expect(fake.methods).toContain("thread/realtime/stop");
      expect(fake.methods).toContain("thread/unsubscribe");
      expect(sharedClientMocks.releaseClient).toHaveBeenCalledWith(fake.client);

      const invalidated = createResponseHarness();
      await expect(
        realtime.handler(createSdpRequest(second.clientSecret), invalidated.res),
      ).resolves.toBe(true);
      expect(invalidated.res.statusCode).toBe(401);
      await expect(realtime.broker.createBrowserSession({ providerConfig: {} })).rejects.toThrow(
        "Codex OAuth realtime is stopping",
      );
    } finally {
      unregister();
      await realtime.cleanup();
    }
  });

  it("aborts and closes backend startup when the browser offer disconnects", async () => {
    const fake = createFakeClient({ stallRealtimeStart: true });
    sharedClientMocks.getClient.mockResolvedValue(fake.client);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getPluginConfig: () => ({}),
    });
    const unregister = registerRealtimeVoiceBrowserSessionBroker(realtime.broker);
    const reservation = await realtime.broker.createBrowserSession({ providerConfig: {} });
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected Codex browser session to use WebRTC");
    }
    const response = createResponseHarness();

    try {
      const handling = realtime.handler(createSdpRequest(reservation.clientSecret), response.res);
      await vi.waitFor(() => {
        expect(fake.readRealtimeStartSignal()).toBeDefined();
      });

      response.close();

      await expect(handling).resolves.toBe(true);
      expect(fake.readRealtimeStartSignal()?.aborted).toBe(true);
      expect(fake.methods).toContain("thread/realtime/stop");
      expect(fake.methods).toContain("thread/unsubscribe");
      expect(sharedClientMocks.releaseClient).toHaveBeenCalledWith(fake.client);
      expect(response.end).not.toHaveBeenCalled();
    } finally {
      unregister();
      await realtime.cleanup();
    }
  });

  it("closes the backend when the browser disconnects while the SDP answer is flushing", async () => {
    const fake = createFakeClient();
    sharedClientMocks.getClient.mockResolvedValue(fake.client);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getPluginConfig: () => ({}),
    });
    const unregister = registerRealtimeVoiceBrowserSessionBroker(realtime.broker);
    const reservation = await realtime.broker.createBrowserSession({ providerConfig: {} });
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected Codex browser session to use WebRTC");
    }
    const response = createResponseHarness({ autoFinish: false });

    try {
      const handling = realtime.handler(createSdpRequest(reservation.clientSecret), response.res);
      await vi.waitFor(() => {
        expect(response.end).toHaveBeenCalledWith("v=answer\r\n");
      });

      response.close();

      await expect(handling).resolves.toBe(true);
      expect(fake.methods).toContain("thread/realtime/stop");
      expect(fake.methods).toContain("thread/unsubscribe");
      expect(sharedClientMocks.releaseClient).toHaveBeenCalledWith(fake.client);
    } finally {
      unregister();
      await realtime.cleanup();
    }
  });

  it("caps concurrent pending and active browser sessions", async () => {
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getPluginConfig: () => ({}),
    });
    await Promise.all(
      Array.from({ length: 8 }, () => realtime.broker.createBrowserSession({ providerConfig: {} })),
    );

    await expect(realtime.broker.createBrowserSession({ providerConfig: {} })).rejects.toThrow(
      "Too many concurrent Codex OAuth realtime sessions",
    );

    await realtime.cleanup();
  });
});

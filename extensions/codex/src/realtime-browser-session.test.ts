import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./app-server/client.js";
import type { CodexServerNotification } from "./app-server/protocol.js";
import {
  CODEX_REALTIME_OFFER_PATH,
  createCodexRealtimeBrowserSessionBroker,
} from "./realtime-browser-session.js";

const sharedClientMocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  getSharedClient: vi.fn(),
  releaseClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => ({
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getClient,
  getSharedCodexAppServerClient: sharedClientMocks.getSharedClient,
  releaseLeasedSharedCodexAppServerClient: sharedClientMocks.releaseClient,
}));

function createSdpRequest(token: string, origin?: string): IncomingMessage {
  return Object.assign(Readable.from(["v=offer\r\n"]), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/sdp",
      ...(origin ? { origin } : {}),
    },
  }) as unknown as IncomingMessage;
}

function createPreflightRequest(origin: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-private-network": "true",
    },
  }) as unknown as IncomingMessage;
}

function createResponseHarness(options: { autoFinish?: boolean } = {}): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
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
  const setHeader = vi.fn();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader,
    end,
  }) as unknown as ServerResponse;
  return {
    res,
    end,
    setHeader,
    readBody: () => body,
    close: () => {
      res.emit("close");
    },
  };
}

function createFakeClient(
  options: {
    stallRealtimeStart?: boolean;
    genericRealtimeStartAbortError?: boolean;
    realtimeStartNotifications?: CodexServerNotification[];
  } = {},
): {
  client: CodexAppServerClient;
  methods: string[];
  emitClose: () => void;
  emitNotification: (notification: CodexServerNotification) => void;
  readRealtimeStartSignal: () => AbortSignal | undefined;
} {
  let closeHandler: ((client: CodexAppServerClient) => void) | undefined;
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
          const notifications = options.realtimeStartNotifications ?? [
            {
              method: "thread/realtime/sdp",
              params: { threadId: "thread-1", sdp: "v=answer\r\n" },
            },
          ];
          queueMicrotask(() => {
            for (const notification of notifications) {
              notificationHandler?.(notification);
            }
          });
          if (options.stallRealtimeStart) {
            return await new Promise((_, reject) => {
              const signal = requestOptions?.signal;
              const rejectAbort = () =>
                reject(
                  options.genericRealtimeStartAbortError
                    ? new Error("request cancelled")
                    : signal?.reason instanceof Error
                      ? signal.reason
                      : new Error("realtime start aborted"),
                );
              signal?.addEventListener("abort", rejectAbort, { once: true });
              if (signal?.aborted) {
                rejectAbort();
              }
            });
          }
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
    addCloseHandler: vi.fn((handler: (client: CodexAppServerClient) => void) => {
      closeHandler = handler;
    }),
  } as unknown as CodexAppServerClient;
  return {
    client,
    methods,
    emitClose: () => closeHandler?.(client),
    emitNotification: (notification) => notificationHandler?.(notification),
    readRealtimeStartSignal: () => realtimeStartSignal,
  };
}

function useFakeClient(fake: ReturnType<typeof createFakeClient>): void {
  sharedClientMocks.getClient.mockResolvedValue(fake.client);
  sharedClientMocks.getSharedClient.mockResolvedValue(fake.client);
}

describe("Codex OAuth realtime browser session", () => {
  beforeEach(() => {
    sharedClientMocks.getClient.mockReset();
    sharedClientMocks.getSharedClient.mockReset();
    sharedClientMocks.releaseClient.mockReset();
  });

  it("advertises the broker only after subscription warmup succeeds", async () => {
    const fake = createFakeClient();
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });

    expect(realtime.broker.isConfigured()).toBe(false);
    await realtime.warmup();
    expect(realtime.broker.isConfigured()).toBe(true);
    expect(sharedClientMocks.getSharedClient).toHaveBeenCalledWith(
      expect.objectContaining({ authRequirement: "subscription" }),
    );

    await realtime.cleanup();
  });

  it("handles offer preflights only for configured Control UI origins", async () => {
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({
        gateway: {
          controlUi: {
            allowedOrigins: ["https://Control.Example"],
          },
        },
      }),
      getPluginConfig: () => ({}),
    });

    try {
      const accepted = createResponseHarness();
      await expect(
        realtime.handler(createPreflightRequest("https://control.example"), accepted.res),
      ).resolves.toBe(true);
      expect(accepted.res.statusCode).toBe(204);
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Origin",
        "https://control.example",
      );
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Methods",
        "POST, OPTIONS",
      );
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Private-Network",
        "true",
      );

      const rejected = createResponseHarness();
      await expect(
        realtime.handler(createPreflightRequest("https://untrusted.example"), rejected.res),
      ).resolves.toBe(true);
      expect(rejected.res.statusCode).toBe(403);
      expect(rejected.setHeader).not.toHaveBeenCalledWith(
        "Access-Control-Allow-Origin",
        expect.anything(),
      );
      expect(sharedClientMocks.getClient).not.toHaveBeenCalled();
    } finally {
      await realtime.cleanup();
    }
  });

  it("probes again after failed warmup without advertising or reserving the failure", async () => {
    const fake = createFakeClient();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    sharedClientMocks.getSharedClient.mockRejectedValueOnce(new Error("ChatGPT login required"));
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });

    await expect(realtime.warmup()).rejects.toThrow("ChatGPT login required");
    expect(realtime.broker.isConfigured()).toBe(false);
    sharedClientMocks.getSharedClient.mockRejectedValueOnce(new Error("ChatGPT login required"));
    await expect(realtime.broker.createBrowserSession({ providerConfig: {} })).rejects.toThrow(
      "ChatGPT login required",
    );

    useFakeClient(fake);
    now.mockReturnValue(11_000);
    expect(realtime.broker.isConfigured()).toBe(false);
    await vi.waitFor(() => {
      expect(realtime.broker.isConfigured()).toBe(true);
    });
    await Promise.all(
      Array.from({ length: 8 }, () => realtime.broker.createBrowserSession({ providerConfig: {} })),
    );

    await realtime.cleanup();
    now.mockRestore();
  });

  it("revalidates after the warmed Codex client closes", async () => {
    const first = createFakeClient();
    const replacement = createFakeClient();
    useFakeClient(first);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });

    try {
      await realtime.warmup();
      const session = await realtime.broker.createBrowserSession({ providerConfig: {} });
      if (session.transport !== "webrtc") {
        throw new Error("Expected Codex browser sessions to use WebRTC");
      }
      await realtime.handler(createSdpRequest(session.clientSecret), createResponseHarness().res);

      sharedClientMocks.getSharedClient.mockResolvedValue(replacement.client);
      first.emitClose();

      await vi.waitFor(() => {
        expect(realtime.broker.isConfigured()).toBe(true);
        expect(sharedClientMocks.releaseClient).toHaveBeenCalledWith(first.client);
      });
      await expect(
        realtime.broker.createBrowserSession({ providerConfig: {} }),
      ).resolves.toMatchObject({
        provider: "openai",
        transport: "webrtc",
      });
      expect(sharedClientMocks.getSharedClient).toHaveBeenLastCalledWith(
        expect.objectContaining({ authRequirement: "subscription" }),
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("redeems browser reservations once and invalidates pending ones on cleanup", async () => {
    const fake = createFakeClient();
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({
        gateway: {
          controlUi: {
            allowedOrigins: ["https://Control.Example"],
          },
        },
      }),
      getPluginConfig: () => ({}),
    });
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
    await realtime.broker.cancelBrowserSession(cancelled);

    try {
      const accepted = createResponseHarness();
      await expect(
        realtime.handler(
          createSdpRequest(first.clientSecret, "https://control.example"),
          accepted.res,
        ),
      ).resolves.toBe(true);
      expect(accepted.res.statusCode).toBe(200);
      expect(accepted.readBody()).toBe("v=answer\r\n");
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Origin",
        "https://control.example",
      );
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
      await realtime.cleanup();
    }
  });

  it("aborts and closes backend startup when the browser offer disconnects", async () => {
    const fake = createFakeClient({ stallRealtimeStart: true });
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });
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
      await realtime.cleanup();
    }
  });

  it("returns the Codex startup error when it arrives before the start response", async () => {
    const fake = createFakeClient({
      stallRealtimeStart: true,
      genericRealtimeStartAbortError: true,
      realtimeStartNotifications: [
        {
          method: "thread/realtime/error",
          params: { threadId: "thread-1", message: "subscription unavailable" },
        },
      ],
    });
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });
    const reservation = await realtime.broker.createBrowserSession({ providerConfig: {} });
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected Codex browser session to use WebRTC");
    }
    const response = createResponseHarness();

    try {
      await expect(
        realtime.handler(createSdpRequest(reservation.clientSecret), response.res),
      ).resolves.toBe(true);
      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toBe("subscription unavailable");
      expect(fake.methods).toContain("thread/realtime/stop");
      expect(fake.methods).toContain("thread/unsubscribe");
    } finally {
      await realtime.cleanup();
    }
  });

  it("does not return an SDP answer after Codex closes during startup", async () => {
    const fake = createFakeClient({
      stallRealtimeStart: true,
      genericRealtimeStartAbortError: true,
      realtimeStartNotifications: [
        {
          method: "thread/realtime/sdp",
          params: { threadId: "thread-1", sdp: "v=stale-answer\r\n" },
        },
        {
          method: "thread/realtime/closed",
          params: { threadId: "thread-1", reason: "backend closed" },
        },
      ],
    });
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });
    const reservation = await realtime.broker.createBrowserSession({ providerConfig: {} });
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected Codex browser session to use WebRTC");
    }
    const response = createResponseHarness();

    try {
      await expect(
        realtime.handler(createSdpRequest(reservation.clientSecret), response.res),
      ).resolves.toBe(true);
      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toBe(
        "Codex realtime session closed before returning an SDP answer",
      );
      expect(response.readBody()).not.toContain("stale-answer");
      expect(fake.methods).toContain("thread/realtime/stop");
      expect(fake.methods).toContain("thread/unsubscribe");
    } finally {
      await realtime.cleanup();
    }
  });

  it("releases the backend when Codex reports an error after startup", async () => {
    const fake = createFakeClient();
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });
    const reservation = await realtime.broker.createBrowserSession({ providerConfig: {} });
    if (reservation.transport !== "webrtc") {
      throw new Error("Expected Codex browser session to use WebRTC");
    }
    const response = createResponseHarness();

    try {
      await expect(
        realtime.handler(createSdpRequest(reservation.clientSecret), response.res),
      ).resolves.toBe(true);

      fake.emitNotification({
        method: "thread/realtime/error",
        params: { threadId: "thread-1", message: "backend failed" },
      });

      await vi.waitFor(() => {
        expect(sharedClientMocks.releaseClient).toHaveBeenCalledWith(fake.client);
      });
      expect(fake.methods).toContain("thread/realtime/stop");
      expect(fake.methods).toContain("thread/unsubscribe");
    } finally {
      await realtime.cleanup();
    }
  });

  it("closes the backend when the browser disconnects while the SDP answer is flushing", async () => {
    const fake = createFakeClient();
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
      getPluginConfig: () => ({}),
    });
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
      await realtime.cleanup();
    }
  });

  it("caps concurrent pending and active browser sessions", async () => {
    const fake = createFakeClient();
    useFakeClient(fake);
    const realtime = createCodexRealtimeBrowserSessionBroker({
      getConfig: () => ({}),
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

// Zalo tests cover monitor.image.polling plugin behavior.
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createLifecycleMonitorSetup,
  expectImageLifecycleDelivery,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  getUpdatesMock,
  getZaloRuntimeMock,
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
} from "./test-support/monitor-mocks-test-support.js";

describe("Zalo polling image handling", () => {
  const {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    readRemoteMediaBufferMock,
    saveRemoteMediaMock,
    saveMediaBufferMock,
  } = createImageLifecycleCore();

  beforeEach(async () => {
    await resetLifecycleTestState();
    getZaloRuntimeMock.mockReturnValue(core);
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  it("downloads inbound image media from photo_url and preserves display_name", async () => {
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({ date: 1774084566880 }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule("zalo-image-polling");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "open",
    });
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await settleAsyncWork();
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expectImageLifecycleDelivery({
      readRemoteMediaBufferMock,
      saveRemoteMediaMock,
      saveMediaBufferMock,
      finalizeInboundContextMock,
      recordInboundSessionMock,
    });
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ Timestamp: 1774084566880 }),
    );

    abort.abort();
    await run;
  });

  it("rejects unauthorized DM images before downloading media", async () => {
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({
          messageId: "msg-unauthorized-1",
          userId: "user-unauthorized-1",
          chatId: "chat-unauthorized-1",
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule("zalo-image-polling");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "pairing",
      allowFrom: ["allowed-user"],
    });
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await settleAsyncWork();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
    expect(finalizeInboundContextMock).not.toHaveBeenCalled();
    expect(recordInboundSessionMock).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it("dispatches an unavailable notice when the inbound image download fails", async () => {
    saveRemoteMediaMock.mockRejectedValueOnce(new Error("expired image URL"));
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({ caption: "/reset" }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule("zalo-image-polling");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "open",
    });
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1));
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "/reset",
        CommandBody: "/reset",
        BodyForAgent: "/reset\n\n[zalo image attachment unavailable]",
        MediaPath: undefined,
      }),
    );

    abort.abort();
    await run;
  });

  it("times out inbound image downloads when photo_url headers never arrive", async () => {
    const { createServer } = await import("node:http");
    const { saveRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
    const { ZALO_MEDIA_READ_IDLE_TIMEOUT_MS, ZALO_MEDIA_RESPONSE_HEADER_TIMEOUT_MS } =
      await import("./monitor.js");

    const server = createServer((_req, _res) => {
      // Accept the connection but never write status/headers.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    const stallUrl = `http://127.0.0.1:${address.port}/stall.jpg`;
    const headerTimeoutMs = 250;

    // Production monitor passes the full timeout budget; the harness shortens
    // only the actual fetch so the stalled-header case stays fast.
    const saveRemoteMediaWithHeaderTimeout: typeof saveRemoteMedia = async (params) => {
      expect(params).toEqual({
        url: stallUrl,
        maxBytes: 5 * 1024 * 1024,
        responseHeaderTimeoutMs: ZALO_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
        readIdleTimeoutMs: ZALO_MEDIA_READ_IDLE_TIMEOUT_MS,
      });
      return await saveRemoteMedia({
        ...params,
        responseHeaderTimeoutMs: headerTimeoutMs,
        ssrfPolicy: { ...params.ssrfPolicy, dangerouslyAllowPrivateNetwork: true },
      });
    };
    saveRemoteMediaMock.mockImplementation(saveRemoteMediaWithHeaderTimeout);

    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({
          caption: "stalled photo",
          photoUrl: stallUrl,
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule("zalo-image-polling");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "open",
    });
    const started = Date.now();
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1));
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(headerTimeoutMs - 50);
    expect(elapsedMs).toBeLessThan(headerTimeoutMs + 5_000);
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "stalled photo\n\n[zalo image attachment unavailable]",
        MediaPath: undefined,
      }),
    );

    abort.abort();
    await run;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});

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
});

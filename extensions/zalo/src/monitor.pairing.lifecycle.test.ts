import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withServer } from "../../../test/helpers/http-test-server.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
  settleAsyncWork,
} from "../test-support/lifecycle-test-support.js";
import {
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "../test-support/monitor-mocks-test-support.js";

describe("Zalo pairing lifecycle", () => {
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
    });
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  function createPairingMonitorSetup() {
    return createLifecycleMonitorSetup({
      accountId: "acct-zalo-pairing",
      dmPolicy: "pairing",
      allowFrom: [],
    });
  }

  it("emits one pairing reply across duplicate webhook replay and scopes reads and writes to accountId", async () => {
    const monitor = await startWebhookLifecycleMonitor({
      ...createPairingMonitorSetup(),
      cacheKey: "zalo-pairing-lifecycle",
    });

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createTextUpdate({
              messageId: `zalo-pairing-${Date.now()}`,
              userId: "user-unauthorized",
              userName: "Unauthorized User",
              chatId: "dm-pairing-1",
            }),
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(readAllowFromStoreMock).toHaveBeenCalledTimes(1);
      expect(readAllowFromStoreMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "zalo",
          accountId: "acct-zalo-pairing",
        }),
      );
      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(upsertPairingRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "zalo",
          accountId: "acct-zalo-pairing",
          id: "user-unauthorized",
        }),
      );
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith(
        "zalo-token",
        expect.objectContaining({
          chat_id: "dm-pairing-1",
          text: expect.stringContaining("PAIRCODE"),
        }),
        undefined,
      );
    } finally {
      await monitor.stop();
    }
  });

  it("does not emit a second pairing reply when replay arrives after the first send fails", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("pairing send failed"));

    const monitor = await startWebhookLifecycleMonitor({
      ...createPairingMonitorSetup(),
      cacheKey: "zalo-pairing-lifecycle",
    });

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createTextUpdate({
              messageId: `zalo-pairing-retry-${Date.now()}`,
              userId: "user-unauthorized",
              userName: "Unauthorized User",
              chatId: "dm-pairing-1",
            }),
            settleBeforeReplay: true,
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(monitor.runtime.error).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});

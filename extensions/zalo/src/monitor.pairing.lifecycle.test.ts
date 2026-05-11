import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

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
      expect(readAllowFromStoreMock).toHaveBeenCalledWith({
        channel: "zalo",
        accountId: "acct-zalo-pairing",
      });
      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(upsertPairingRequestMock).toHaveBeenCalledWith({
        channel: "zalo",
        accountId: "acct-zalo-pairing",
        id: "user-unauthorized",
        meta: { name: "Unauthorized User" },
      });
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [sendToken, sendPayload, sendOptions] = sendMessageMock.mock.calls[0] as [
        string,
        { chat_id?: string; text?: string },
        unknown,
      ];
      expect(sendToken).toBe("zalo-token");
      expect(sendPayload.chat_id).toBe("dm-pairing-1");
      expect(sendPayload.text).toContain("PAIRCODE");
      expect(sendOptions).toBeUndefined();
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

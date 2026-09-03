// Feishu tests cover the shared outbound delivery path.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendStickerFeishu: vi.fn(),
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: () => false,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: vi.fn(),
}));

import { feishuPlugin } from "./channel.js";
import { feishuChannelRuntime } from "./channel.runtime.js";
import { feishuOutbound } from "./outbound.js";

type DeliveryQueueRow = {
  status: string;
  recovery_state: string | null;
  platform_send_started_at: number | null;
};

const completionRetention = {
  idPrefix: "feishu-direct-",
  maxAgeMs: 60_000,
  maxEntries: 10,
} as const;

function readDeliveryQueueRow(stateDir: string, id: string): DeliveryQueueRow | undefined {
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        `SELECT status, recovery_state, platform_send_started_at
           FROM delivery_queue_entries
          WHERE queue_name = 'outbound-prepared-v1' AND id = ?`,
      )
      .get(id) as DeliveryQueueRow | undefined;
  } finally {
    database.close();
  }
}

describe("Feishu outbound shared delivery", () => {
  beforeEach(() => {
    let textMessageIndex = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue({
      messageId: "media-1",
      chatId: "chat_1",
    });
    sendMessageFeishuMock.mockReset().mockImplementation(async () => ({
      messageId: `text-${String(++textMessageIndex)}`,
      chatId: "chat_1",
    }));
    sendCardFeishuMock.mockReset().mockResolvedValue({
      messageId: "card-1",
      chatId: "chat_1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu",
          plugin: createOutboundTestPlugin({ id: "feishu", outbound: feishuOutbound }),
          source: "test",
        },
      ]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  it("routes oversized presentation media through one media send and chunked fallback text", async () => {
    const label = "Open the complete retained workflow run details";
    const readFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile,
    };
    await sendDurableMessageBatch({
      cfg: {},
      channel: "feishu",
      to: "chat_1",
      skipQueue: true,
      mediaAccess,
      payloads: [
        {
          mediaUrl: "pipeline.png",
          presentation: {
            blocks: [
              {
                type: "table",
                caption: "Large pipeline",
                headers: ["Account", "Stage"],
                rows: Array.from({ length: 400 }, (_entry, index) => [
                  `account-${String(index)}-${"x".repeat(80)}`,
                  "Review",
                ]),
              },
              {
                type: "buttons",
                buttons: [{ label, action: { type: "command", command: "/open-run" } }],
              },
            ],
          },
        },
      ],
    });

    const textChunks = sendMessageFeishuMock.mock.calls.map((call) => {
      const text = (call[0] as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : "";
    });
    const deliveredText = textChunks.join("\n");

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "pipeline.png",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: readFile,
        to: "chat_1",
      }),
    );
    const sentMedia = sendMediaFeishuMock.mock.calls[0]?.[0] as {
      mediaAccess?: { localRoots?: readonly string[]; readFile?: typeof readFile };
    };
    expect(sentMedia.mediaAccess?.localRoots).toBe(mediaAccess.localRoots);
    expect(sentMedia.mediaAccess?.readFile).toBe(readFile);
    expect(textChunks.length).toBeGreaterThan(1);
    expect(textChunks.every((chunk) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
    expect(deliveredText).toContain(`- ${label}: \`/open-run\``);
  });

  it("replays a queued direct message after Feishu runtime availability is restored", async () => {
    const originalSendText = feishuChannelRuntime.feishuOutbound.sendText;
    if (!originalSendText) {
      throw new Error("Expected Feishu runtime sendText");
    }
    const deliveryIntentId = "feishu-direct-runtime-availability";

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
    );
    feishuChannelRuntime.feishuOutbound.sendText = undefined;

    try {
      await withStateDirEnv("openclaw-feishu-runtime-availability-", async ({ stateDir }) => {
        const initial = await sendDurableMessageBatch({
          cfg: {},
          channel: "feishu",
          to: "chat_1",
          accountId: "default",
          durability: "required",
          deliveryIntentId,
          completionRetention,
          maxRetries: 2,
          payloads: [{ text: "retry after runtime restoration" }],
        });

        expect(initial.status).toBe("failed");
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)).toMatchObject({
          status: "pending",
          recovery_state: null,
          platform_send_started_at: null,
        });

        feishuChannelRuntime.feishuOutbound.sendText = originalSendText;
        await drainPendingDeliveries({
          drainKey: "feishu:default",
          logLabel: "Feishu runtime availability recovery",
          cfg: {},
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          selectEntry: (entry) => ({
            match: entry.channel === "feishu",
            bypassBackoff: true,
          }),
        });

        expect(sendMessageFeishuMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            to: "chat_1",
            text: "retry after runtime restoration",
          }),
        );
        expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.status).toBe("completed");
      });
    } finally {
      feishuChannelRuntime.feishuOutbound.sendText = originalSendText;
    }
  });

  it("does not replay a Feishu provider call after dispatch may have begun", async () => {
    const deliveryIntentId = "feishu-direct-ambiguous-provider-result";
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("Feishu provider result was lost"));
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuPlugin, source: "test" }]),
    );

    await withStateDirEnv("openclaw-feishu-ambiguous-provider-", async ({ stateDir }) => {
      const initial = await sendDurableMessageBatch({
        cfg: {},
        channel: "feishu",
        to: "chat_1",
        accountId: "default",
        durability: "required",
        deliveryIntentId,
        completionRetention,
        maxRetries: 2,
        payloads: [{ text: "do not replay an ambiguous provider call" }],
      });

      expect(initial.status).toBe("failed");
      expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
      expect(readDeliveryQueueRow(stateDir, deliveryIntentId)).toMatchObject({
        status: "pending",
        recovery_state: "send_attempt_started",
      });
      expect(readDeliveryQueueRow(stateDir, deliveryIntentId)?.platform_send_started_at).toEqual(
        expect.any(Number),
      );

      await drainPendingDeliveries({
        drainKey: "feishu:default",
        logLabel: "Feishu ambiguous provider recovery",
        cfg: {},
        stateDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        selectEntry: (entry) => ({
          match: entry.channel === "feishu",
          bypassBackoff: true,
        }),
      });

      expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    });
  });
});

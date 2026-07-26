// Whatsapp tests cover the durable outbound handoff across startup recovery.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappChannelOutbound } from "./channel-outbound.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const runtimeContextMocks = vi.hoisted(() => ({
  controllers: new Map<string, unknown>(),
}));

vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: (accountId: string) =>
    runtimeContextMocks.controllers.get(accountId) ?? null,
}));

const cfg = { channels: { whatsapp: {} } } as OpenClawConfig;
const accountId = "default";

async function drainDefaultWhatsAppDeliveries(stateDir: string) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  await drainPendingDeliveries({
    drainKey: `whatsapp:${accountId}`,
    logLabel: "WhatsApp reconnect drain",
    cfg,
    log,
    stateDir,
    selectEntry: (entry) => ({
      match:
        entry.channel === "whatsapp" && ((entry.accountId ?? "").trim() || accountId) === accountId,
      bypassBackoff:
        typeof entry.lastError === "string" &&
        entry.lastError.includes("No active WhatsApp Web listener"),
    }),
  });
  return log;
}

describe("WhatsApp delivery recovery", () => {
  beforeEach(() => {
    runtimeContextMocks.controllers.clear();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "whatsapp",
            outbound: whatsappChannelOutbound,
          }),
        },
      ]),
    );
  });

  afterEach(() => {
    runtimeContextMocks.controllers.clear();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("keeps pre-connect recovery replayable, then sends exactly once after connect", async () => {
    await withStateDirEnv("openclaw-whatsapp-delivery-recovery-", async ({ stateDir }) => {
      const initialResult = await sendDurableMessageBatch({
        cfg,
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "queued before listener startup" }],
        durability: "required",
      });
      expect(initialResult).toMatchObject({
        status: "failed",
        error: {
          cause: expect.any(PlatformMessageNotDispatchedError),
        },
      });

      const preConnectLog = await drainDefaultWhatsAppDeliveries(stateDir);
      expect(preConnectLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("No active WhatsApp Web listener"),
      );

      const sendMessage = vi.fn(async () =>
        createAcceptedWhatsAppSendResult("text", "recovered-message"),
      );
      const listener: ActiveWebListener = {
        sendComposingTo: vi.fn(async () => {}),
        sendMessage,
        sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll")),
        sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", "reaction")),
      };
      const controller = {
        getActiveListener: () => listener,
        getCurrentSock: () => null,
        getSelfIdentity: () => null,
      };
      runtimeContextMocks.controllers.set(accountId, controller);

      await drainDefaultWhatsAppDeliveries(stateDir);
      await drainDefaultWhatsAppDeliveries(stateDir);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "+1555",
        "queued before listener startup",
        undefined,
        undefined,
      );
    });
  });
});

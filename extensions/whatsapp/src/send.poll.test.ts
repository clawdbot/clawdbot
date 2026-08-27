// WhatsApp tests cover poll outbound behavior.
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const hoisted = vi.hoisted(() => ({
  controllerListeners: new Map<string, ActiveWebListener>(),
  rememberWhatsAppOwnPollCreation: vi.fn(),
}));
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let resetLogger: typeof import("openclaw/plugin-sdk/runtime-env").resetLogger;
let setLoggerOverride: typeof import("openclaw/plugin-sdk/runtime-env").setLoggerOverride;

const WHATSAPP_TEST_CFG: OpenClawConfig = {
  channels: { whatsapp: {} },
};
const WHATSAPP_TEST_CFG_WITH_POLL_HOOK: OpenClawConfig = {
  channels: { whatsapp: { pluginHooks: { pollVoteReceived: true } } },
};

vi.mock("./connection-controller-runtime-context.js", async () => {
  const actual = await vi.importActual<typeof import("./connection-controller-runtime-context.js")>(
    "./connection-controller-runtime-context.js",
  );
  return {
    ...actual,
    getWhatsAppConnectionController: vi.fn((accountId: string) => {
      const listener = hoisted.controllerListeners.get(accountId) ?? null;
      return listener
        ? {
            getActiveListener: () => listener,
          }
        : null;
    }),
  };
});

vi.mock("./inbound/poll-votes.js", async () => {
  const actual =
    await vi.importActual<typeof import("./inbound/poll-votes.js")>("./inbound/poll-votes.js");
  return {
    ...actual,
    rememberWhatsAppOwnPollCreation: hoisted.rememberWhatsAppOwnPollCreation,
  };
});

describe("web outbound polls", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "msg123"));
  const sendPoll = vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll123"));
  const sendReaction = vi.fn(async () =>
    createAcceptedWhatsAppSendResult("reaction", "reaction123"),
  );

  beforeAll(async () => {
    ({ sendPollWhatsApp } = await import("./send.js"));
    const { resetLogger: loadedResetLogger, setLoggerOverride: loadedSetLoggerOverride } =
      await import("openclaw/plugin-sdk/runtime-env");
    resetLogger = loadedResetLogger;
    setLoggerOverride = loadedSetLoggerOverride;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.controllerListeners.clear();
    hoisted.controllerListeners.set("default", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    hoisted.controllerListeners.clear();
  });

  it.each([
    { cfg: WHATSAPP_TEST_CFG_WITH_POLL_HOOK, ownsPoll: true },
    { cfg: WHATSAPP_TEST_CFG, ownsPoll: false },
  ])(
    "sends polls and records ownership only when the hook is enabled",
    async ({ cfg, ownsPoll }) => {
      const result = await sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 2 },
        { verbose: false, cfg },
      );
      expect(result).toEqual({
        messageId: "poll123",
        toJid: "1555@s.whatsapp.net",
      });
      expect(sendPoll).toHaveBeenCalledWith("+1555", {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 2,
        durationSeconds: undefined,
        durationHours: undefined,
      });
      expect(hoisted.rememberWhatsAppOwnPollCreation).toHaveBeenCalledTimes(ownsPoll ? 1 : 0);
      if (ownsPoll) {
        expect(hoisted.rememberWhatsAppOwnPollCreation).toHaveBeenCalledWith(
          "default",
          "1555@s.whatsapp.net",
          "poll123",
        );
      }
    },
  );

  it("rejects polls without an accepted provider message key", async () => {
    sendPoll.mockResolvedValueOnce({
      kind: "poll",
      messageId: "unknown",
      keys: [],
      providerAccepted: false,
    });

    await expect(
      sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        { verbose: false, cfg: WHATSAPP_TEST_CFG },
      ),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(sendPoll).toHaveBeenCalledOnce();
  });

  it("returns the actual outbound poll key when Baileys resolves a LID target", async () => {
    sendPoll.mockResolvedValueOnce({
      kind: "poll",
      messageId: "poll-lid",
      keys: [
        {
          id: "poll-lid",
          remoteJid: "123456789@lid",
          fromMe: true,
        },
      ],
      providerAccepted: true,
    });

    await expect(
      sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        { verbose: false, cfg: WHATSAPP_TEST_CFG },
      ),
    ).resolves.toEqual({
      messageId: "poll-lid",
      toJid: "123456789@lid",
    });
  });

  it("checks send readiness before sending direct polls", async () => {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        { verbose: false, cfg: WHATSAPP_TEST_CFG },
      ),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it("redacts recipients and poll text in outbound logs", async () => {
    const logPath = path.join(os.tmpdir(), `openclaw-outbound-${crypto.randomUUID()}.log`);
    setLoggerOverride({ level: "trace", file: logPath });

    await sendPollWhatsApp(
      "+1555",
      { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 1 },
      { verbose: false, cfg: WHATSAPP_TEST_CFG },
    );

    const redactedTarget = redactIdentifier("+1555");
    const redactedJid = redactIdentifier("1555@s.whatsapp.net");
    let content = "";
    await vi.waitFor(
      () => {
        content = fsSync.existsSync(logPath) ? fsSync.readFileSync(logPath, "utf-8") : "";
        expect(content).toContain(redactedTarget);
        expect(content).toContain(redactedJid);
        expect(content).toContain("sent poll");
      },
      { timeout: 2_000, interval: 5 },
    );

    expect(content).not.toContain(`"to":"+1555"`);
    expect(content).not.toContain(`"jid":"1555@s.whatsapp.net"`);
    expect(content).not.toContain("Lunch?");
  });
});

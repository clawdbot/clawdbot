import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_CONTAINER_HINT", "OPENCLAW_PROFILE"]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    process.env.OPENCLAW_PROFILE = "isolated";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  const pairingReplyCases = [
    {
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
    },
    {
      channel: "discord",
      idLine: "Your Discord user id: 1",
      code: "ABC123",
    },
    {
      channel: "slack",
      idLine: "Your Slack user id: U1",
      code: "DEF456",
    },
    {
      channel: "signal",
      idLine: "Your Signal number: +15550001111",
      code: "GHI789",
    },
    {
      channel: "imessage",
      idLine: "Your iMessage sender id: +15550002222",
      code: "JKL012",
    },
    {
      channel: "whatsapp",
      idLine: "Your WhatsApp phone number: +15550003333",
      code: "MNO345",
    },
  ] as const;

  function expectPairingApproveCommand(text: string, testCase: (typeof pairingReplyCases)[number]) {
    const commandRe = new RegExp(
      `(?:openclaw|openclaw) --profile isolated pairing approve ${testCase.channel} ${testCase.code}`,
    );
    expect(text).toMatch(commandRe);
  }

  function expectProfileAwarePairingReply(testCase: (typeof pairingReplyCases)[number]) {
    const text = buildPairingReply(testCase);
    expectPairingReplyText(text, testCase);
    expectPairingApproveCommand(text, testCase);
  }

  it.each(pairingReplyCases)("formats pairing reply for $channel", (testCase) => {
    expectProfileAwarePairingReply(testCase);
  });
});

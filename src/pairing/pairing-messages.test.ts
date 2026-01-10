import { describe, expect, it } from "vitest";

import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  const cases = [
    {
      provider: "discord",
      idLine: "Your Discord user id: 1",
      code: "ABC123",
    },
    {
      provider: "slack",
      idLine: "Your Slack user id: U1",
      code: "DEF456",
    },
    {
      provider: "signal",
      idLine: "Your Signal number: +15550001111",
      code: "GHI789",
    },
    {
      provider: "imessage",
      idLine: "Your iMessage sender id: +15550002222",
      code: "JKL012",
    },
    {
      provider: "whatsapp",
      idLine: "Your WhatsApp phone number: +15550003333",
      code: "MNO345",
    },
  ] as const;

  for (const testCase of cases) {
    it(`formats pairing reply for ${testCase.provider}`, () => {
      const text = buildPairingReply(testCase);
      expect(text).toContain(testCase.idLine);
      expect(text).toContain(`Pairing code: ${testCase.code}`);
      expect(text).toContain(
        `clawdbot pairing approve ${testCase.provider} <code>`,
      );
    });
  }
});

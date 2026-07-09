import { describe, expect, it } from "vitest";
import {
  formatStatusTextContinuationLine,
  resolveStatusChannelFeatureLine,
} from "./status-text.js";

const zeroContinuationLineParams = {
  maxChainLength: 8,
  chainCount: 0,
  pending: 0,
  staged: 0,
  volitional: 0,
};

describe("formatStatusTextContinuationLine", () => {
  it("omits the continuation row when all fields are zero", () => {
    expect(formatStatusTextContinuationLine(zeroContinuationLineParams)).toBeUndefined();
  });

  it.each([
    {
      name: "chain count",
      input: { chainCount: 1 },
      expected: "🔄 Continuation: chain 1/8",
    },
    {
      name: "pending delegates",
      input: { pending: 2 },
      expected: "🔄 Continuation: chain 0/8 | 2 delegates pending",
    },
    {
      name: "staged post-compaction delegates",
      input: { staged: 1 },
      expected: "🔄 Continuation: chain 0/8 | 1 post-compaction staged",
    },
    {
      name: "volitional compactions",
      input: { volitional: 1 },
      expected: "🔄 Continuation: chain 0/8 | volitional: 1",
    },
  ])("renders the continuation row when $name is non-zero", ({ input, expected }) => {
    const line = formatStatusTextContinuationLine({
      ...zeroContinuationLineParams,
      ...input,
    });

    expect(line).toBe(expected);
  });
});

describe("buildStatusText channel features", () => {
  it.each([
    { richMessages: undefined, expected: "Telegram rich messages: off" },
    { richMessages: false, expected: "Telegram rich messages: off" },
    { richMessages: true, expected: "Telegram rich messages: on" },
  ])("shows Telegram rich message state for %s", ({ richMessages, expected }) => {
    const telegram = richMessages === undefined ? {} : { richMessages };
    const text = resolveStatusChannelFeatureLine({
      cfg: { channels: { telegram } },
      sessionEntry: { sessionId: `telegram-rich-${String(richMessages)}`, updatedAt: 0 },
      statusChannel: "telegram",
    });

    expect(text).toContain(expected);
    if (richMessages === true) {
      expect(text).toContain("sendRichMessage enabled");
    } else {
      expect(text).toContain("channels.telegram.richMessages=true");
    }
  });

  it("uses Telegram account rich message overrides", () => {
    const text = resolveStatusChannelFeatureLine({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-account",
        updatedAt: 0,
        lastAccountId: "work",
      },
      statusChannel: "telegram",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });

  it("uses the current Telegram command account before the session records it", () => {
    const text = resolveStatusChannelFeatureLine({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-command-account",
        updatedAt: 0,
      },
      statusChannel: "telegram",
      statusAccountId: "work",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });
});

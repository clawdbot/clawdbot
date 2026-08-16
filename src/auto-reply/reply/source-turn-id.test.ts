import { describe, expect, it } from "vitest";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
  shouldMintChannelSourceTurnId,
} from "./source-turn-id.js";

describe("buildChannelSourceTurnId", () => {
  it("is stable for the same normalized channel route", () => {
    expect(
      buildChannelSourceTurnId({
        provider: "Telegram",
        accountId: "DEFAULT",
        conversationId: "chat:42",
        messageId: 7,
      }),
    ).toBe(
      buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "default",
        conversationId: "chat:42",
        messageId: "7",
      }),
    );
  });

  it("scopes provider-local message ids by conversation and account", () => {
    const sourceTurnId = buildChannelSourceTurnId({
      provider: "telegram",
      accountId: "default",
      conversationId: "chat:42",
      messageId: "7",
    });
    expect(sourceTurnId).toMatch(/^channel-user:v1:[a-f0-9]{64}$/);
    expect(
      buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "default",
        conversationId: "chat:43",
        messageId: "7",
      }),
    ).not.toBe(sourceTurnId);
    expect(
      buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "ops",
        conversationId: "chat:42",
        messageId: "7",
      }),
    ).not.toBe(sourceTurnId);
  });

  it("fails closed without complete route scope", () => {
    expect(
      buildChannelSourceTurnId({ provider: "telegram", conversationId: "chat:42" }),
    ).toBeUndefined();
    expect(buildChannelSourceTurnId({ provider: "telegram", messageId: "7" })).toBeUndefined();
  });

  it("carries host-only identity through context clones without serializing it", () => {
    const context = { MessageSid: "7" };
    setChannelSourceTurnId(context, "channel-user:v1:source-7");
    setChannelSourceTurnSameThreadRequired(context, true);

    expect(readChannelSourceTurnId({ ...context })).toBe("channel-user:v1:source-7");
    expect(readChannelSourceTurnSameThreadRequired({ ...context })).toBe(true);
    expect(JSON.stringify(context)).toBe('{"MessageSid":"7"}');
  });
  it("does not mint channel source-turn ids for internal-origin ingress", () => {
    // Gateway chat.send stamps the internal channel as the ingress provider and
    // keys the persisted user turn by run id; minting a channel id there would
    // trip the source-keyed admission guard (live regression via #108283).
    expect(shouldMintChannelSourceTurnId("webchat")).toBe(false);
    expect(shouldMintChannelSourceTurnId("telegram")).toBe(true);
    expect(shouldMintChannelSourceTurnId(undefined)).toBe(true);
  });
});

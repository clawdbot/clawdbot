import { beforeEach, describe, expect, it, vi } from "vitest";
import { outboundMessageIdentities } from "./outbound-echo-state.js";
import { isRecentOutboundMessageIdentity, recordOutboundMessageIdentity } from "./outbound-echo.js";

describe("outbound message identity registry", () => {
  beforeEach(() => {
    outboundMessageIdentities.clear();
    vi.restoreAllMocks();
  });

  it("scopes identities by channel and account", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    recordOutboundMessageIdentity({
      channel: "Discord",
      accountId: "Work",
      conversationId: "thread-1",
      messageId: "message-1",
    });

    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        accountId: "work",
        conversationId: "thread-1",
        messageId: "message-1",
      }),
    ).toBe(true);
    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        accountId: "other",
        conversationId: "thread-1",
        messageId: "message-1",
      }),
    ).toBe(false);
    expect(
      isRecentOutboundMessageIdentity({
        channel: "slack",
        accountId: "work",
        conversationId: "thread-1",
        messageId: "message-1",
      }),
    ).toBe(false);
    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        accountId: "work",
        conversationId: "thread-2",
        messageId: "message-1",
      }),
    ).toBe(false);
  });

  it("expires identities after the bounded echo window", () => {
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const identity = {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      messageId: "message-1",
    };
    recordOutboundMessageIdentity(identity);

    nowMs += 29_999;
    expect(isRecentOutboundMessageIdentity(identity)).toBe(true);
    nowMs += 1;
    expect(isRecentOutboundMessageIdentity(identity)).toBe(false);
  });

  it("does not retain identities when the expiry timestamp overflows", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const identity = {
      channel: "discord",
      conversationId: "thread-1",
      messageId: "message-overflow",
    };
    recordOutboundMessageIdentity(identity);

    expect(isRecentOutboundMessageIdentity(identity)).toBe(false);
  });

  it("evicts the oldest identity when the registry reaches its entry bound", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    for (let index = 0; index <= 10_000; index += 1) {
      recordOutboundMessageIdentity({
        channel: "discord",
        conversationId: "thread-1",
        messageId: `message-${index}`,
      });
    }

    expect(outboundMessageIdentities.size).toBe(10_000);
    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        conversationId: "thread-1",
        messageId: "message-0",
      }),
    ).toBe(false);
    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        conversationId: "thread-1",
        messageId: "message-10000",
      }),
    ).toBe(true);
  });

  it("matches a transport-defined outbound source identity", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    recordOutboundMessageIdentity({
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      sourceId: "webhook-1",
    });

    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        accountId: "default",
        conversationId: "thread-1",
        sourceId: "webhook-1",
      }),
    ).toBe(true);
  });
});

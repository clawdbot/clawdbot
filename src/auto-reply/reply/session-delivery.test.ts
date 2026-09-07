// Tests how session delivery preserves previous channel and target routing state.
import { describe, expect, it } from "vitest";
import { resolveSessionDeliveryRoute } from "./session-delivery.js";

describe("inter-session lastRoute preservation (fixes #54441)", () => {
  it("inter-session message does NOT overwrite established Discord lastChannel", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "discord",
        sessionKey: "agent:samantha:main",
        isInterSession: true,
      }).channel,
    ).toBe("discord");
  });

  it("inter-session message does NOT overwrite established Telegram lastChannel", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        sessionKey: "agent:main:telegram:direct:123456",
        isInterSession: true,
      }).channel,
    ).toBe("telegram");
  });

  it("inter-session message does NOT overwrite established external lastTo", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:somekey",
        toRaw: "session:somekey",
        persistedLastTo: "channel:1234567890",
        persistedLastChannel: "discord",
        sessionKey: "agent:samantha:main",
        isInterSession: true,
      }).to,
    ).toBe("channel:1234567890");
  });

  it("regular Discord user message DOES update lastChannel normally", () => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "discord",
        persistedLastChannel: "discord",
        sessionKey: "agent:main:discord:channel:123",
        isInterSession: false,
      }).channel,
    ).toBe("discord");
  });

  it("inter-session on a NEW session (no persisted external route) may set webchat", () => {
    // When there is no established external route, inter-session should not
    // forcefully block the update — the session has no external route to protect.
    const result = resolveSessionDeliveryRoute({
      originatingChannelRaw: "webchat",
      persistedLastChannel: undefined,
      sessionKey: "agent:samantha:main",
      isInterSession: true,
    }).channel;
    // No external route existed — falls through to normal resolution (webchat or undefined).
    expect(["webchat", undefined]).toContain(result);
  });

  it("inter-session on session with no persisted lastTo preserves session route", () => {
    const result = resolveSessionDeliveryRoute({
      originatingChannelRaw: "webchat",
      originatingToRaw: "session:somekey",
      toRaw: "session:somekey",
      persistedLastTo: undefined,
      persistedLastChannel: undefined,
      sessionKey: "agent:samantha:main",
      isInterSession: true,
    }).to;
    // No external route — falls through to normal resolution
    expect(["session:somekey", undefined]).toContain(result);
  });
});

describe("session delivery direct-session routing overrides", () => {
  it.each([
    "agent:main:direct:user-1",
    "agent:main:telegram:direct:123456",
    "agent:main:telegram:account-a:direct:123456",
    "agent:main:telegram:dm:123456",
    "agent:main:telegram:direct:123456:thread:99",
    "agent:main:telegram:account-a:direct:123456:topic:ops",
  ])(
    "preserves persisted external route when webchat accesses channel-peer session %s (fixes #47745)",
    (sessionKey) => {
      // Webchat/dashboard viewing an external-channel session must not overwrite
      // the delivery route — subagents must still deliver to the original channel.
      expect(
        resolveSessionDeliveryRoute({
          originatingChannelRaw: "webchat",
          originatingToRaw: "session:dashboard",
          persistedLastChannel: "telegram",
          persistedLastTo: "123456",
          sessionKey,
        }),
      ).toEqual({ channel: "telegram", to: "123456" });
    },
  );

  it.each([
    "agent:main:main:direct",
    "agent:main:cron:job-1:dm",
    "agent:main:subagent:worker:direct:user-1",
    "agent:main:telegram:channel:direct",
    "agent:main:telegram:account-a:direct",
    "agent:main:telegram:direct:123456:cron:job-1",
  ])("keeps persisted external routes for malformed direct-like key %s", (sessionKey) => {
    expect(
      resolveSessionDeliveryRoute({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "group:12345",
        sessionKey,
      }),
    ).toEqual({ channel: "telegram", to: "group:12345" });
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

describe("buildIMessageInboundContext direct reply route", () => {
  it("uses the exact chat GUID when no numeric chat ID is available", async () => {
    const cfg = {} as OpenClawConfig;
    const message = {
      id: 12349,
      guid: "p:0/GUID-current-guid-only",
      sender: "+15555550123",
      text: "current",
      is_from_me: false,
      is_group: false,
      chat_guid: "iMessage;-;+15555550123",
    };
    const decision = await resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      opts: undefined,
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      selfChatCache: undefined,
      isKnownFromMeMessageId: () => false,
      logVerbose: undefined,
      message,
      messageText: message.text,
      bodyText: message.text,
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { ctxPayload, imessageTo } = await buildIMessageInboundContext({
      cfg,
      accountService: undefined,
      decision,
      message,
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(ctxPayload.To).toBe("chat_guid:iMessage;-;+15555550123");
    expect(imessageTo).toBe("imessage:+15555550123");
  });
});

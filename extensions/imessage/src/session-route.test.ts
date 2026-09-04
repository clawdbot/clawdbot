import { describe, expect, it } from "vitest";
import { imessagePlugin } from "./channel.js";

describe("iMessage outbound session routing", () => {
  it.each([
    ["+15551234567", true],
    ["+1 (555) 123-4567", true],
    ["imessage:User@Example.com", true],
    ["imessage:Alice", false],
    ["sms:foo", false],
    ["alice@example", false],
    ["1-800-FLOWERS", false],
    ["chat_id:42", false],
    ["chat_guid:iMessage;+;chat123", false],
    ["chat_identifier:team-thread", false],
  ] as const)("reports canonical identity for %s", async (target, exact) => {
    const route = await imessagePlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target,
    });

    expect(route?.recipientSessionExact).toBe(exact);
  });

  it.each([
    ["uses auto when a bare direct target has no configured service", {}, "+15551234567", "auto"],
    [
      "uses the configured SMS override for a bare direct target",
      { channels: { imessage: { service: "sms" } } },
      "+15551234567",
      "sms",
    ],
    [
      "uses the configured iMessage override for a bare direct target",
      { channels: { imessage: { service: "imessage" } } },
      "+15551234567",
      "imessage",
    ],
    [
      "keeps an explicit SMS target authoritative",
      { channels: { imessage: { service: "imessage" } } },
      "sms:+15551234567",
      "sms",
    ],
    [
      "keeps an explicit auto target authoritative",
      { channels: { imessage: { service: "sms" } } },
      "auto:+15551234567",
      "auto",
    ],
  ] as const)("%s", async (_label, cfg, target, expectedService) => {
    const route = await imessagePlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg,
      agentId: "main",
      target,
    });

    expect(route).toMatchObject({
      from: `${expectedService}:+15551234567`,
      to: `${expectedService}:+15551234567`,
    });
  });
});

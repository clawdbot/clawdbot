// Imessage test support covers dm history plugin behavior.
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "../client.js";
import { resolveIMessageDmHistoryContext, resolveIMessageDmHistoryLimit } from "./dm-history.js";

describe("resolveIMessageDmHistoryLimit", () => {
  it("uses per-DM history overrides before the provider default", () => {
    expect(
      resolveIMessageDmHistoryLimit({
        config: {
          dmHistoryLimit: 5,
          dms: {
            "+15555550123": { historyLimit: 2 },
          },
        },
        sender: "+1 (555) 555-0123",
        senderNormalized: "+15555550123",
      }),
    ).toBe(2);
  });

  it("defaults to disabled when no iMessage DM history limit is configured", () => {
    expect(resolveIMessageDmHistoryLimit({ config: {}, sender: "+15555550123" })).toBe(0);
  });
});

describe("resolveIMessageDmHistoryContext", () => {
  it("fetches decoded imsg history rows and excludes the current message", async () => {
    const request = vi.fn(async () => ({
      messages: [
        {
          id: 8,
          guid: "previous-in",
          chat_id: 44,
          sender: "+15555550123",
          is_from_me: false,
          text: "earlier inbound",
          created_at: "2026-05-25T12:00:00.000Z",
          is_group: false,
        },
        {
          id: 9,
          guid: "previous-out",
          chat_id: 44,
          sender: null,
          is_from_me: true,
          text: "earlier outbound",
          created_at: "2026-05-25T12:01:00.000Z",
          is_group: false,
        },
        {
          id: 10,
          guid: "current",
          chat_id: 44,
          sender: "+15555550123",
          is_from_me: false,
          text: "current",
          created_at: "2026-05-25T12:02:00.000Z",
          is_group: false,
        },
      ],
    }));

    const context = await resolveIMessageDmHistoryContext({
      client: { request } as unknown as IMessageRpcClient,
      message: {
        id: 10,
        guid: "current",
        chat_id: 44,
        sender: "+15555550123",
        text: "current",
        is_from_me: false,
        is_group: false,
      },
      senderNormalized: "+15555550123",
      limit: 2,
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
    });

    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 44, limit: 3, attachments: false },
      { timeoutMs: 10_000 },
    );
    expect(context.inboundHistory).toEqual([
      {
        sender: "+15555550123",
        body: "earlier inbound",
        timestamp: Date.parse("2026-05-25T12:00:00.000Z"),
      },
      {
        sender: "Me",
        body: "earlier outbound",
        timestamp: Date.parse("2026-05-25T12:01:00.000Z"),
      },
    ]);
    expect(context.body).toContain("earlier inbound");
    expect(context.body).toContain("earlier outbound");
    expect(context.body).not.toContain("current");
  });
});

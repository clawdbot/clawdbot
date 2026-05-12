import { describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function readFirstMockArg(fn: unknown): unknown {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
}

describe("createMatrixRoomMessageHandler thread root media", () => {
  it("keeps image-only thread roots visible via attachment markers", async () => {
    installMatrixMonitorTestRuntime();

    const formatAgentEnvelope = vi
      .fn()
      .mockImplementation((params: { body: string }) => params.body);
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getUserId: async () => "@bot:matrix.example.org",
        getEvent: async () =>
          createMatrixRoomMessageEvent({
            eventId: "$thread-root",
            sender: "@gum:matrix.example.org",
            originServerTs: 123,
            content: {
              msgtype: "m.image",
              body: "photo.jpg",
            } as never,
          }),
      },
      formatAgentEnvelope,
      shouldHandleTextCommands: () => true,
      resolveMarkdownTableMode: () => "code",
      resolveAgentRoute: () => ({
        agentId: "main",
        accountId: "ops",
        sessionKey: "agent:main:matrix:channel:!room:example.org",
        mainSessionKey: "agent:main:main",
        channel: "matrix",
        matchedBy: "binding.account",
      }),
      resolveStorePath: () => "/tmp/openclaw-test-session.json",
      getRoomInfo: async () => ({
        name: "Media Room",
        canonicalAlias: "#media:example.org",
        altAliases: [],
      }),
      getMemberDisplayName: async () => "Gum",
      startupMs: Date.now() - 120_000,
      startupGraceMs: 60_000,
      textLimit: 4000,
      mediaMaxBytes: 5 * 1024 * 1024,
      replyToMode: "first",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply",
        sender: "@bu:matrix.example.org",
        body: "replying",
        mentions: { user_ids: ["@bot:matrix.example.org"] },
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$thread-root",
        },
      }),
    );

    expect(formatAgentEnvelope).toHaveBeenCalledTimes(1);
    const envelope = requireRecord(
      formatAgentEnvelope.mock.calls[0]?.[0],
      "format agent envelope params",
    );
    expect(String(envelope.body)).toContain("replying");

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const inbound = requireRecord(readFirstMockArg(recordInboundSession), "record inbound session");
    const ctx = requireRecord(inbound.ctx, "inbound context");
    expect(String(ctx.ThreadStarterBody)).toContain("[matrix image attachment]");
  });
});

// Tests for CLI message text formatting helpers (renderMessageList, formatMessageCliText).
import { describe, expect, it, vi } from "vitest";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import { formatMessageCliText } from "./message-format.js";

const getChannelPluginMock = vi.hoisted(() =>
  vi.fn((channel: string) =>
    channel === "directchat" ? { meta: { label: "Direct Chat" } } : undefined,
  ),
);

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  getLoadedChannelPlugin: getChannelPluginMock,
}));

function readResultPayload(payload: unknown) {
  return {
    kind: "action" as const,
    channel: "matrix" as const,
    action: "read" as const,
    handledBy: "plugin" as const,
    payload,
    dryRun: false,
  };
}

function pinsResultPayload(payload: unknown) {
  return {
    kind: "action" as const,
    channel: "matrix" as const,
    action: "list-pins" as const,
    handledBy: "plugin" as const,
    payload,
    dryRun: false,
  };
}

function searchResultPayload(payload: unknown) {
  return {
    kind: "action" as const,
    channel: "discord" as const,
    action: "search" as const,
    handledBy: "plugin" as const,
    payload,
    dryRun: false,
  };
}

function msg(id: string, ts: string, authorTag: string, content: string) {
  return { id, ts, authorTag, content };
}

function textJoined(lines: string[]): string {
  return lines.join("\n");
}

describe("formatMessageCliText displayLimit", () => {
  it("honors displayLimit for message read", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`id-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `text-${i}`),
    );

    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 15 }));

    // Should include items within the limit
    expect(out).toContain("text-0");
    expect(out).toContain("text-14");
    // Should NOT include items beyond the limit
    expect(out).not.toContain("text-15");
  });

  it("honors displayLimit for list-pins", () => {
    const pins = Array.from({ length: 40 }, (_, i) =>
      msg(`pin-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `pin-text-${i}`),
    );

    const result = pinsResultPayload({ pins });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 15 }));

    expect(out).toContain("pin-text-0");
    expect(out).toContain("pin-text-14");
    expect(out).not.toContain("pin-text-15");
  });

  it("honors displayLimit for search", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`id-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `search-${i}`),
    );
    // Discord search returns messages as array-of-array
    const wrapped = messages.map((m) => [m]);

    const result = searchResultPayload({ results: { messages: wrapped } });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 15 }));

    expect(out).toContain("search-0");
    expect(out).toContain("search-14");
    expect(out).not.toContain("search-15");
  });

  it("defaults to 25 when no displayLimit is provided", () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      msg(`id-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `text-${i}`),
    );

    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result));

    expect(out).toContain("text-24");
    expect(out).not.toContain("text-25");
  });

  it("renders all rows when total is below displayLimit", () => {
    const messages = [
      msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello"),
      msg("id-2", "2026-01-01T00:00:01.000Z", "bob", "world"),
    ];

    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 30 }));

    expect(out).toContain("hello");
    expect(out).toContain("world");
  });
});

describe("renderPaginationHint", () => {
  it("emits hint when payload has hasMore: true", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages, hasMore: true });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
  });

  it("emits hint when payload has nextBatch string", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages, nextBatch: "token-123" });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
  });

  it("emits hint when payload has @odata.nextLink string", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({
      messages,
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
    });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
  });

  it("emits hint when search results has hasMore without total_results", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    // hasMore: true inside results — Discord does not always include total_results.
    const wrapped = messages.map((m) => [m]);
    const result = searchResultPayload({
      results: { messages: wrapped, hasMore: true },
    });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
  });

  it("emits hint when total_results exceeds returned count (Discord search)", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    // Discord search wraps messages and total_results inside a results object.
    // total_results: 200 with 1 returned message → 199 more exist.
    const wrapped = messages.map((m) => [m]);
    const result = searchResultPayload({
      results: { messages: wrapped, total_results: 200 },
    });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
  });

  it("does NOT emit hint when total_results equals returned count (completed search)", () => {
    const messages = [
      msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello"),
      msg("id-2", "2026-01-01T00:00:01.000Z", "bob", "world"),
    ];
    // total_results: 2 with 2 returned messages → search is complete.
    const wrapped = messages.map((m) => [m]);
    const result = searchResultPayload({
      results: { messages: wrapped, total_results: 2 },
    });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).not.toContain("More results available");
  });

  it("does NOT emit hint when no pagination signal is present", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).not.toContain("More results available");
  });
});

describe("formatMessageCliText poll results", () => {
  it("formats direct core poll results as direct deliveries", () => {
    const result = {
      kind: "poll",
      action: "poll",
      channel: "directchat",
      to: "room-1",
      handledBy: "core",
      payload: {},
      dryRun: false,
      pollResult: {
        channel: "directchat",
        to: "room-1",
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
        durationSeconds: null,
        durationHours: null,
        via: "direct",
        result: {
          messageId: "p1",
          conversationId: "conv-1",
          pollId: "poll-1",
        },
      },
    } satisfies MessageActionRunResult;

    expect(formatMessageCliText(result)).toEqual([
      "✅ Poll sent via Direct Chat. Message ID: p1 (conversation conv-1)",
      "Poll id: poll-1",
    ]);
  });
});

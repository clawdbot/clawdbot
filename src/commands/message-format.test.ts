// Tests for CLI message text formatting helpers (renderMessageList, formatMessageCliText).
import { describe, expect, it, vi } from "vitest";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
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

  it.each([
    { displayLimit: 1, expectedRows: 1 },
    { displayLimit: 75, expectedRows: 75 },
    { displayLimit: undefined, expectedRows: 50 },
  ])(
    "renders $expectedRows reaction rows for displayLimit $displayLimit",
    ({ displayLimit, expectedRows }) => {
      const reactions = Array.from({ length: 80 }, (_, index) => ({
        name: `reaction-${String(index).padStart(2, "0")}`,
        count: index + 1,
      }));
      const result = {
        kind: "action",
        channel: "matrix",
        action: "reactions",
        handledBy: "plugin",
        payload: { reactions },
        dryRun: false,
      } satisfies MessageActionResult;

      const output = textJoined(formatMessageCliText(result, { displayLimit }));

      expect(output).toContain(`reaction-${String(expectedRows - 1).padStart(2, "0")}`);
      expect(output).not.toContain(`reaction-${String(expectedRows).padStart(2, "0")}`);
    },
  );

  it.each([0, 1])(
    "renders an explicit outcome for a search with no results (total: %i)",
    (totalResults) => {
      const result = searchResultPayload({
        results: { messages: [], total_results: totalResults },
      });

      expect(formatMessageCliText(result)).toEqual(["Search results", "No results."]);
    },
  );

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

describe("formatMessageCliText reaction labels", () => {
  it.each(["raw", "name", "emoji", "key"] as const)(
    "renders untrusted %s reaction cells as plain terminal text",
    (field) => {
      const label = "\u001b[2Jreaction\nline";
      const reaction = field === "raw" ? { emoji: { raw: label } } : { [field]: label };
      const result = {
        kind: "action",
        channel: "matrix",
        action: "reactions",
        handledBy: "plugin",
        payload: {
          reactions: [{ ...reaction, count: 2, users: ["\u001b[31malice\u001b[0m", "bob\tother"] }],
        },
        dryRun: false,
      } satisfies MessageActionResult;
      const payload = structuredClone(result.payload);

      const output = textJoined(formatMessageCliText(result));

      expect(result.payload).toEqual(payload);
      expect(output).not.toContain("\u001b[2J");
      expect(output).toContain("reaction\\nline");
      expect(output).toContain("alice");
      expect(output).toContain("bob\\tother");
      expect(output.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
    },
  );

  it.each([
    ["matrix", { key: "👍" }, "👍"],
    ["matrix", { key: ":party_parrot:" }, ":party_parrot:"],
    ["discord", { emoji: { id: "123", name: "party", raw: "party:123" } }, "party:123"],
    ["slack", { name: "thumbsup" }, "thumbsup"],
    ["msteams", { name: "like", emoji: "👍" }, "like"],
    [
      "directchat",
      { emoji: { raw: "raw-priority" }, name: "unused-name", key: "unused-key" },
      "raw-priority",
    ],
    [
      "directchat",
      { name: "name-priority", emoji: "unused-emoji", key: "unused-key" },
      "name-priority",
    ],
    ["directchat", { emoji: "🦞", key: "unused-key" }, "🦞"],
  ] as const)("renders %s reaction labels from their result shape", (channel, reaction, label) => {
    const result = {
      kind: "action",
      channel,
      action: "reactions",
      handledBy: "plugin",
      payload: {
        reactions: [{ ...reaction, count: 2, users: ["@alice:qa.test", "@bob:qa.test"] }],
      },
      dryRun: false,
    } satisfies MessageActionResult;

    const output = textJoined(formatMessageCliText(result));

    expect(output).toContain(label);
    expect(output).toContain("@alice:qa.test");
    expect(output).toContain("@bob:qa.test");
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

  it.each([0, 1])("preserves explicit search continuation with %i returned messages", (count) => {
    const messages = Array.from({ length: count }, (_, index) =>
      msg(`id-${index}`, "2026-01-01T00:00:00.000Z", "alice", "hello"),
    );
    const result = searchResultPayload({
      results: { messages: messages.map((message) => [message]), hasMore: true },
    });

    expect(textJoined(formatMessageCliText(result, { displayLimit: 5 }))).toContain(
      "More results available",
    );
  });

  it.each([2, 200])(
    "does not infer more search results from approximate total %i",
    (totalResults) => {
      const message = msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello");
      const result = searchResultPayload({
        results: { messages: [[message]], total_results: totalResults },
      });

      expect(textJoined(formatMessageCliText(result, { displayLimit: 5 }))).not.toContain(
        "More results available",
      );
    },
  );

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

describe("formatMessageCliText send results", () => {
  it("prefers and trims a direct plugin payload message ID", () => {
    const result = {
      kind: "send",
      action: "send",
      channel: "directchat",
      to: "room-1",
      handledBy: "plugin",
      payload: {
        messageId: " direct-id ",
        result: { messageId: "nested-id" },
      },
      dryRun: false,
    } satisfies MessageActionResult;

    expect(formatMessageCliText(result)).toEqual([
      "✅ Sent via Direct Chat. Message ID: direct-id",
    ]);
  });

  it.each([
    {
      status: "suppressed" as const,
      suppressionReason: "cancelled_by_message_sending_hook" as const,
      expected: "Message send suppressed: cancelled_by_message_sending_hook.",
    },
    {
      status: "failed" as const,
      error: "provider rejected the message",
      expected: "provider rejected the message",
    },
    {
      status: "partial_failed" as const,
      error: "second attachment rejected",
      messageId: "first-part-1",
      expected: "second attachment rejected",
    },
  ])(
    "reports a $status delivery without claiming success",
    ({ status, suppressionReason, error, messageId, expected }) => {
      const result = {
        kind: "send",
        action: "send",
        channel: "directchat",
        to: "room-1",
        handledBy: "core",
        payload: {},
        dryRun: false,
        sendResult: {
          channel: "directchat",
          to: "room-1",
          via: "direct",
          mediaUrl: null,
          deliveryStatus: status,
          ...(suppressionReason ? { suppressionReason } : {}),
          ...(error ? { error } : {}),
          ...(messageId ? { result: { channel: "directchat", messageId } } : {}),
        },
      } satisfies MessageActionResult;

      const output = textJoined(formatMessageCliText(result));

      expect(output).toContain(expected);
      expect(output).not.toContain("✅ Sent");
      if (messageId) {
        expect(output).toContain(`Message ID: ${messageId}`);
      }
    },
  );
});

describe("formatMessageCliText payload scalars", () => {
  it("keeps alias reads lazy after the first nonempty string", () => {
    const reads: string[] = [];
    const message = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(message, {
      id: {
        enumerable: true,
        get: () => {
          reads.push("id");
          return reads.length === 1 ? "first-id" : "second-id";
        },
      },
      ts: {
        enumerable: true,
        get: () => {
          reads.push("ts");
          throw new Error("later alias must not be read");
        },
      },
      authorTag: { enumerable: true, value: "alice" },
      timestamp: { enumerable: true, value: "now" },
      content: { enumerable: true, value: "hello" },
    });

    const output = textJoined(formatMessageCliText(readResultPayload({ messages: [message] })));
    expect(output).toContain("second-id");
    expect(output).not.toContain("first-id");
    expect(reads).toEqual(["id", "id"]);
  });

  it("preserves generic object primitive summaries", () => {
    const result = {
      kind: "action",
      channel: "directchat",
      action: "channel-info",
      handledBy: "plugin",
      payload: {
        undef: undefined,
        nil: null,
        array: [1, 2],
        object: {},
        function: () => undefined,
        bigint: 42n,
        symbol: Symbol("proof"),
        string: "  keep  ",
        number: -3,
        boolean: false,
      },
      dryRun: false,
    } satisfies MessageActionResult;

    const output = textJoined(formatMessageCliText(result));
    for (const expected of [
      "null",
      "2 items",
      "object",
      "function",
      "42",
      "Symbol(proof)",
      "keep",
      "-3",
      "false",
    ]) {
      expect(output).toContain(expected);
    }
  });
});

describe("formatMessageCliText provider-reported failures", () => {
  it.each([
    ["disabled reaction", "react", { ok: false, hint: "Reactions are disabled." }, "disabled"],
    [
      "rejected added reaction",
      "react",
      { ok: false, warning: "Unavailable", added: "✅" },
      "Unavailable",
    ],
    [
      "rejected delete",
      "delete",
      { ok: false, deleted: false, warning: "Not deleted" },
      "Not deleted",
    ],
    ["rejected poll", "poll", { ok: false, error: "Poll rejected" }, "Poll rejected"],
    ["rejected send", "send", { ok: false, error: "Message rejected" }, "Message rejected"],
  ] as const)("reports %s without claiming success", (_name, action, payload, expected) => {
    const result = {
      kind: action === "send" || action === "poll" ? action : "action",
      channel: "telegram",
      action,
      to: "123",
      handledBy: "plugin",
      payload,
      dryRun: false,
    } as MessageActionResult;

    const output = textJoined(formatMessageCliText(result));

    expect(output).toContain(expected);
    expect(output).not.toContain("✅");
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
          target: { kind: "conversation", id: "conv-1" },
          pollId: "poll-1",
        },
      },
    } satisfies MessageActionResult;

    expect(formatMessageCliText(result)).toEqual([
      "✅ Poll sent via Direct Chat. Message ID: p1 (conversation conv-1)",
      "Poll id: poll-1",
    ]);
  });
});

describe("formatMessageCliText broadcast results", () => {
  it("reports aggregate failure while preserving every target row", () => {
    const result = {
      kind: "broadcast",
      action: "broadcast",
      channel: "directchat",
      handledBy: "core",
      payload: {
        results: [
          ...Array.from({ length: 51 }, (_, index) => ({
            channel: "directchat" as const,
            to: `room-ok-${index}`,
            ok: true as const,
          })),
          {
            channel: "directchat",
            to: "room-suppressed",
            ok: false,
            error: "Broadcast send suppressed: cancelled_by_message_sending_hook.",
          },
          {
            channel: "directchat",
            to: "room-partial",
            ok: false,
            error: "second payload failed",
            sentBeforeError: true,
          },
        ],
      },
      dryRun: false,
    } satisfies MessageActionResult;

    const output = textJoined(formatMessageCliText(result));

    expect(output).toContain("Broadcast failed (51/53 succeeded, 2 failed)");
    expect(output).not.toContain("Broadcast complete");
    expect(output).toContain("room-ok-50");
    expect(output).toContain("room-suppressed");
    expect(output).toContain("room-partial");
    expect(output).toContain("Broadcast send suppressed");
    expect(output).toContain("second payload failed");
  });
});

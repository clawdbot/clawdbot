// Regression coverage for pruning duplicate user turns before compaction.
import { describe, expect, it } from "vitest";
import { Agent } from "../../../packages/agent-core/src/agent.js";
import { SessionManager } from "../sessions/session-manager.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";

const LONG_PROMPT = "please run the deployment status check for production";

function userMessage(params: {
  timestamp: number;
  senderId?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
}) {
  const metadata = params.metadata ?? (params.senderId ? { senderId: params.senderId } : undefined);
  return {
    role: "user" as const,
    content: params.content ?? LONG_PROMPT,
    timestamp: params.timestamp,
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

describe("compaction duplicate user message pruning", () => {
  it("drops identical long user messages inside the duplicate window", () => {
    // Whitespace-normalized duplicates inside the short window are transport
    // artifacts; keeping both wastes compaction budget and distorts summaries.
    const first = {
      role: "user",
      content: "please run the deployment status check for production",
      timestamp: 1_000,
    } as const;
    const second = {
      role: "user",
      content: " please   run the deployment status check for production ",
      timestamp: 2_000,
    } as const;
    const third = {
      role: "assistant",
      content: [{ type: "text", text: "checking" }],
      timestamp: 3_000,
    } as const;

    expect(dedupeDuplicateUserMessagesForCompaction([first, second, third])).toEqual([
      first,
      third,
    ]);
  });

  it("keeps short repeated acknowledgements and distant repeats", () => {
    // Short repeats and distant repeats are plausible user intent, so only
    // high-confidence duplicated long prompts are removed.
    const short = { role: "user", content: "next", timestamp: 1_000 } as const;
    const shortAgain = { role: "user", content: "next", timestamp: 2_000 } as const;
    const long = {
      role: "user",
      content: "please run the deployment status check for production",
      timestamp: 1_000,
    } as const;
    const longLater = {
      role: "user",
      content: "please run the deployment status check for production",
      timestamp: 70_000,
    } as const;

    expect(dedupeDuplicateUserMessagesForCompaction([short, shortAgain])).toEqual([
      short,
      shortAgain,
    ]);
    expect(dedupeDuplicateUserMessagesForCompaction([long, longLater])).toEqual([long, longLater]);
  });

  it("keys duplicate retries by sender identity (#98310)", () => {
    const alice = userMessage({ timestamp: 1_000, senderId: "user-alice" });
    const bob = userMessage({ timestamp: 2_000, senderId: "user-bob" });
    const aliceRetry = userMessage({ timestamp: 3_000, senderId: "user-alice" });

    expect(dedupeDuplicateUserMessagesForCompaction([alice, bob, aliceRetry])).toEqual([
      alice,
      bob,
    ]);
  });

  it.each([
    [
      "username-only and display-name-only participants",
      [
        userMessage({ timestamp: 1_000, metadata: { senderUsername: "Alice" } }),
        userMessage({ timestamp: 2_000, metadata: { senderUsername: "Bob" } }),
        userMessage({ timestamp: 3_000, metadata: { senderName: "Alice" } }),
        userMessage({ timestamp: 4_000, metadata: { senderName: "Bob" } }),
      ],
      [0, 1, 2, 3],
    ],
    [
      "case-sensitive corrections",
      [
        userMessage({
          timestamp: 1_000,
          content: "set deployment token to SecretValueForProduction",
        }),
        userMessage({
          timestamp: 2_000,
          content: "set deployment token to secretvalueforproduction",
        }),
      ],
      [0, 1],
    ],
    [
      "independent normal and backdated retry streams",
      [90_000, 1_000, 91_000, 2_000, 92_000, 3_000].map((timestamp) => userMessage({ timestamp })),
      [0, 1],
    ],
    [
      "retries after distant chronological jumps",
      [1_000, 90_000, 2_000].map((timestamp) => userMessage({ timestamp })),
      [0, 1],
    ],
    [
      "late retries after a window-edge primary update",
      [1_000, 61_000, 2_000].map((timestamp) => userMessage({ timestamp })),
      [0],
    ],
    [
      "late retries after sliding primary updates",
      [1_000, 2_000, 61_000, 3_000].map((timestamp) => userMessage({ timestamp })),
      [0],
    ],
    [
      "retries from three independently interleaved timelines",
      [1_000, 90_000, 200_000, 2_000, 91_000, 201_000].map((timestamp) =>
        userMessage({ timestamp }),
      ),
      [0, 1, 2],
    ],
    [
      "provider-native attachment blocks and canonical persisted media",
      [
        userMessage({
          timestamp: 1_000,
          content: [{ type: "text", text: LONG_PROMPT }, { type: "input_image", source: "first" }],
        }),
        userMessage({
          timestamp: 2_000,
          content: [{ type: "text", text: LONG_PROMPT }, { type: "input_image", source: "second" }],
        }),
        userMessage({ timestamp: 3_000, metadata: { media: [{ path: "/tmp/first.png" }] } }),
        userMessage({ timestamp: 4_000, metadata: { media: [{ path: "/tmp/second.png" }] } }),
      ],
      [0, 1, 2, 3],
    ],
    [
      "actual duplicate retries",
      [userMessage({ timestamp: 1_000 }), userMessage({ timestamp: 2_000 })],
      [0],
    ],
  ] as const)(
    "preserves %s through the real session and model boundary",
    async (_, messages, keptIndexes) => {
      const sessionManager = SessionManager.inMemory();
      for (const message of messages) {
        sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
      }
      const agent = new Agent({
        initialState: { messages: sessionManager.buildSessionContext().messages },
        streamFn: () => {
          throw new Error("compaction proof must not start a provider request");
        },
      });
      agent.state.messages = dedupeDuplicateUserMessagesForCompaction(agent.state.messages);
      const expectedMessages = keptIndexes.map((index) => messages[index]);

      expect(agent.state.messages).toEqual(expectedMessages);
      expect(await agent.convertToLlm(agent.state.messages)).toEqual(expectedMessages);
    },
  );

  it.each([
    ["distinct usernames", { senderUsername: "Alice" }, { senderUsername: "Bob" }, true],
    ["distinct display names", { senderName: "Alice" }, { senderName: "Bob" }, true],
    [
      "normalized sender identity",
      { senderUsername: " Alice " },
      { senderUsername: "Alice" },
      false,
    ],
    [
      "stable sender id after display rename",
      { senderId: " stable-sender ", senderUsername: "before", senderName: "Before" },
      { senderId: "stable-sender", senderUsername: "after", senderName: "After" },
      false,
    ],
    [
      "blank sender ids with distinct usernames",
      { senderId: "  ", senderUsername: "alice" },
      { senderId: "", senderUsername: "bob" },
      true,
    ],
    [
      "matching sender id and username values",
      { senderId: "alice" },
      { senderUsername: "alice" },
      true,
    ],
  ] as const)("keys retries by canonical sender identity: %s", (_, first, second, keepSecond) => {
    const original = userMessage({ timestamp: 1_000, metadata: first });
    const candidate = userMessage({ timestamp: 2_000, metadata: second });

    expect(dedupeDuplicateUserMessagesForCompaction([original, candidate])).toEqual(
      keepSecond ? [original, candidate] : [original],
    );
  });

  it.each([
    ["primary retries", [90_000, 1_000, 91_000], [0, 1]],
    ["backdated retries", [90_000, 1_000, 2_000], [0, 1]],
    ["retries after a distant forward jump", [1_000, 90_000, 2_000], [0, 1]],
    ["seeded interleaved retry streams", [1_000, 90_000, 2_000, 91_000, 3_000], [0, 1]],
    ["preserved seed across repeated jumps", [1_000, 90_000, 200_000, 2_000], [0, 1, 2]],
    ["preserved active late timeline", [90_000, 1_000, 200_000, 2_000], [0, 1, 2]],
    ["window-edge primary retries", [1_000, 61_000, 2_000], [0]],
    ["sliding primary retries", [1_000, 2_000, 61_000, 3_000], [0]],
    ["previous-bucket latest timestamps", [0, 59_000, 61_000], [0]],
    ["current-bucket earliest timestamps", [59_000, 1_000, 2_000], [0, 1]],
    ["inclusive duplicate-window boundaries", [0, 60_000], [0]],
    ["outside duplicate-window boundaries", [0, 60_001], [0, 1]],
    ["negative epoch timestamps", [-1_000, -120_000, -119_000], [0, 1]],
    [
      "three independently interleaved timelines",
      [1_000, 90_000, 200_000, 2_000, 91_000, 201_000],
      [0, 1, 2],
    ],
    ["interleaved retry streams", [90_000, 1_000, 91_000, 2_000, 92_000, 3_000], [0, 1]],
    ["restarted backdated streams", [90_000, 20_000, 1_000, 2_000], [0, 1, 2]],
  ] as const)("tracks independent chronology watermarks for %s", (_, timestamps, keptIndexes) => {
    const messages = timestamps.map((timestamp) => userMessage({ timestamp }));

    expect(dedupeDuplicateUserMessagesForCompaction(messages)).toEqual(
      keptIndexes.map((index) => messages[index]),
    );
  });

  it.each([
    ["exact timestamps", 0, [1_000, 1_000, 2_000], [0, 2]],
    ["negative windows", -1, [1_000, 1_000, 2_000], [0, 1, 2]],
    ["invalid windows", Number.NaN, [1_000, 1_000, 2_000], [0, 1, 2]],
    ["infinite windows", Number.POSITIVE_INFINITY, [1_000, 2_000, 90_000], [0]],
    ["inclusive fractional windows", 2.5, [0, 2.5], [0]],
    ["outside fractional windows", 2.5, [0, 2.5001], [0, 1]],
    ["backdated fractional windows", 2.5, [2.4, 0.1, 0.2], [0, 1]],
  ] as const)("supports %s", (_, windowMs, timestamps, keptIndexes) => {
    const messages = timestamps.map((timestamp) => userMessage({ timestamp }));

    expect(dedupeDuplicateUserMessagesForCompaction(messages, { windowMs })).toEqual(
      keptIndexes.map((index) => messages[index]),
    );
  });

  it("preserves non-finite timestamps without poisoning ordinary retries", () => {
    const messages = [
      1_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2_000,
    ].map((timestamp) => userMessage({ timestamp }));

    expect(dedupeDuplicateUserMessagesForCompaction(messages)).toEqual(messages.slice(0, -1));
  });

  it.each([
    "image",
    "image_url",
    "input_image",
    "input_audio",
    "audio",
    "file",
    "document",
    "future_attachment",
  ])("preserves distinct %s attachments", (type) => {
    const first = userMessage({
      timestamp: 1_000,
      content: [{ type: "text", text: LONG_PROMPT }, { type, source: "first-attachment" }],
    });
    const second = userMessage({
      timestamp: 2_000,
      content: [{ type: "text", text: LONG_PROMPT }, { type, source: "second-attachment" }],
    });

    expect(dedupeDuplicateUserMessagesForCompaction([first, second])).toEqual([first, second]);
  });

  it.each([
    { name: "meaningful persisted media", media: [{ path: "/tmp/attachment.png" }], keep: true },
    { name: "empty media alignment", media: [{}], keep: false },
  ])("handles canonical persisted attachment identity: $name", ({ media, keep }) => {
    const first = userMessage({ timestamp: 1_000, metadata: { media } });
    const second = userMessage({ timestamp: 2_000, metadata: { media } });

    expect(dedupeDuplicateUserMessagesForCompaction([first, second])).toEqual(
      keep ? [first, second] : [first],
    );
  });

  it.each([
    {
      name: "Unicode-equivalent plain text",
      first: "please deploy the café service to production now",
      second: "please deploy the cafe\u0301 service to production now",
    },
    {
      name: "pure text-block content",
      first: [{ type: "text", text: LONG_PROMPT }],
      second: [{ type: "text", text: ` ${LONG_PROMPT} ` }],
    },
  ])("still removes legitimate retries with $name", ({ first, second }) => {
    const original = userMessage({ timestamp: 1_000, content: first });
    const retry = userMessage({ timestamp: 2_000, content: second });

    expect(dedupeDuplicateUserMessagesForCompaction([original, retry])).toEqual([original]);
  });

  it("does not collide when sender ids and text contain the old delimiter", () => {
    const first = userMessage({
      content: "b|please run deployment status now",
      timestamp: 1_000,
      senderId: "a",
    });
    const second = userMessage({
      content: "please run deployment status now",
      timestamp: 2_000,
      senderId: "a|b",
    });

    expect(dedupeDuplicateUserMessagesForCompaction([first, second])).toEqual([first, second]);
  });
});

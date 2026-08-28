// Regression coverage for pruning duplicate user turns before compaction.
import { describe, expect, it } from "vitest";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";

const LONG_PROMPT = "please run the deployment status check for production";

function userMessage(params: { timestamp: number; senderId?: string; content?: string }) {
  return {
    role: "user" as const,
    content: params.content ?? LONG_PROMPT,
    timestamp: params.timestamp,
    ...(params.senderId ? { __openclaw: { senderId: params.senderId } } : {}),
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
    {
      name: "a completed assistant reply",
      completedTurn: [
        { role: "assistant", content: [{ type: "text", text: "first reply" }], timestamp: 1_500 },
      ],
    },
    {
      name: "an assistant tool call and its result",
      completedTurn: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          timestamp: 1_500,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "read complete" }],
          timestamp: 1_750,
        },
      ],
    },
  ])("preserves the same user request after $name", ({ completedTurn }) => {
    const first = userMessage({ timestamp: 1_000 });
    const next = userMessage({ timestamp: 2_000 });
    const messages = [first, ...completedTurn, next];

    expect(dedupeDuplicateUserMessagesForCompaction(messages)).toEqual(messages);
  });

  it.each([
    { name: "images", kind: "image", extension: "png" },
    { name: "videos", kind: "video", extension: "mp4" },
    { name: "documents", kind: "document", extension: "pdf" },
  ])("preserves separately attached $name with the same caption", ({ kind, extension }) => {
    const first = {
      ...userMessage({ timestamp: 1_000 }),
      __openclaw: { media: [{ kind, url: `media://inbound/first.${extension}` }] },
    };
    const second = {
      ...userMessage({ timestamp: 2_000 }),
      __openclaw: { media: [{ kind, url: `media://inbound/second.${extension}` }] },
    };

    expect(dedupeDuplicateUserMessagesForCompaction([first, second])).toEqual([first, second]);
  });

  it("preserves an attachment added to a previously text-only request", () => {
    const first = userMessage({ timestamp: 1_000 });
    const second = {
      ...userMessage({ timestamp: 2_000 }),
      __openclaw: { media: [{ kind: "image", url: "media://inbound/diagram.png" }] },
    };

    expect(dedupeDuplicateUserMessagesForCompaction([first, second])).toEqual([first, second]);
  });

  it("preserves prompts with distinct case-sensitive paths", () => {
    const first = userMessage({
      timestamp: 1_000,
      content: "please inspect /srv/Production/ReleaseNotes.md",
    });
    const second = userMessage({
      timestamp: 2_000,
      content: "please inspect /srv/production/releasenotes.md",
    });

    expect(dedupeDuplicateUserMessagesForCompaction([first, second])).toEqual([first, second]);
  });

  it("preserves older requests without losing the newest retry timestamp", () => {
    const newer = userMessage({ timestamp: 120_000 });
    const older = userMessage({ timestamp: 1_000 });
    const retry = userMessage({ timestamp: 121_000 });

    expect(dedupeDuplicateUserMessagesForCompaction([newer, older, retry])).toEqual([newer, older]);
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

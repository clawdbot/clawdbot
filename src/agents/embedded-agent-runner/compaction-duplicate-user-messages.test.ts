// Regression coverage for pruning duplicate user turns before compaction.
import { describe, expect, it } from "vitest";
import {
  collectDuplicateUserMessageEntryIdsForCompaction,
  dedupeDuplicateUserMessagesForCompaction,
} from "./compaction-duplicate-user-messages.js";

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

  it("collects duplicate transcript entry ids from active branch entries", () => {
    const duplicateIds = collectDuplicateUserMessageEntryIdsForCompaction([
      {
        id: "entry-1",
        type: "message",
        message: {
          role: "user",
          content: "please run the deployment status check for production",
          timestamp: 1_000,
        },
      },
      {
        id: "entry-2",
        type: "message",
        message: {
          role: "user",
          content: "please run the deployment status check for production",
          timestamp: 2_000,
        },
      },
    ]);

    expect(duplicateIds).toEqual(new Set(["entry-2"]));
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

  it("keeps same text from different senders in successor transcript pruning", () => {
    const alice = userMessage({ timestamp: 1_000, senderId: "user-alice" });
    const bob = userMessage({ timestamp: 2_000, senderId: "user-bob" });
    const duplicateIds = collectDuplicateUserMessageEntryIdsForCompaction([
      { id: "entry-alice", type: "message", message: alice },
      { id: "entry-bob", type: "message", message: bob },
    ]);

    expect(duplicateIds).toEqual(new Set());
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

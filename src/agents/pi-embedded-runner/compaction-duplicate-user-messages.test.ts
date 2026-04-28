import { describe, expect, it } from "vitest";
import {
  collectDuplicateUserMessageEntryIdsForCompaction,
  dedupeDuplicateUserMessagesForCompaction,
} from "./compaction-duplicate-user-messages.js";

describe("compaction duplicate user message pruning", () => {
  it("drops identical long user messages inside the duplicate window", () => {
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
});

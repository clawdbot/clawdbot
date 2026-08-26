import { describe, expect, it } from "vitest";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";

function message(params: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
  second: number;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: `2026-07-22T00:00:${String(params.second).padStart(2, "0")}.000Z`,
    message: { role: params.role, content: params.content },
  };
}

describe("reset boundary planning", () => {
  it("selects repeated reset tails from the current logical window", async () => {
    const oldUser = message({
      id: "old-user",
      parentId: null,
      role: "user",
      content: "discarded",
      second: 1,
    });
    const oldAssistant = message({
      id: "old-assistant",
      parentId: oldUser.id,
      role: "assistant",
      content: "discarded answer",
      second: 2,
    });
    const keptUser = message({
      id: "kept-user",
      parentId: oldAssistant.id,
      role: "user",
      content: "kept",
      second: 3,
    });
    const keptAssistant = message({
      id: "kept-assistant",
      parentId: keptUser.id,
      role: "assistant",
      content: "kept answer",
      second: 4,
    });
    const firstReset = {
      type: "reset",
      id: "first-reset",
      parentId: keptAssistant.id,
      timestamp: "2026-07-22T00:00:05.000Z",
      reason: "new",
      firstKeptEntryId: keptUser.id,
    };

    expect(
      buildSessionResetBoundaryEvent({
        events: [oldUser, oldAssistant, keptUser, keptAssistant, firstReset],
        reason: "reset",
      }),
    ).toMatchObject({
      parentId: firstReset.id,
      firstKeptEntryId: keptUser.id,
    });
  });

  it("keeps a compaction retained tail when planning the next reset", async () => {
    const discarded = message({
      id: "discarded-user",
      parentId: null,
      role: "user",
      content: "discarded",
      second: 1,
    });
    const keptUser = message({
      id: "compaction-kept-user",
      parentId: discarded.id,
      role: "user",
      content: "kept",
      second: 2,
    });
    const keptAssistant = message({
      id: "compaction-kept-assistant",
      parentId: keptUser.id,
      role: "assistant",
      content: "kept answer",
      second: 3,
    });
    const compaction = {
      type: "compaction",
      id: "compaction-boundary",
      parentId: keptAssistant.id,
      timestamp: "2026-07-22T00:00:04.000Z",
      summary: "summary",
      firstKeptEntryId: keptUser.id,
      tokensBefore: 100,
    };

    expect(
      buildSessionResetBoundaryEvent({
        events: [discarded, keptUser, keptAssistant, compaction],
        reason: "new",
      }),
    ).toMatchObject({
      parentId: compaction.id,
      firstKeptEntryId: keptUser.id,
    });
  });
});

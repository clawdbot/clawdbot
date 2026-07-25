import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { buildSessionResetBoundaryPlan } from "./session-reset-boundary-event.js";

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
      (
        await buildSessionResetBoundaryPlan({
          events: [oldUser, oldAssistant, keptUser, keptAssistant, firstReset],
          reason: "reset",
        })
      ).event,
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
      (
        await buildSessionResetBoundaryPlan({
          events: [discarded, keptUser, keptAssistant, compaction],
          reason: "new",
        })
      ).event,
    ).toMatchObject({
      parentId: compaction.id,
      firstKeptEntryId: keptUser.id,
    });
  });

  it("seeds only the bounded replay tail from a legacy transcript", async () => {
    await withTempDir({ prefix: "openclaw-reset-boundary-" }, async (dir) => {
      const sessionFile = path.join(dir, "legacy.jsonl");
      const records = Array.from({ length: 20 }, (_, index) =>
        message({
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
          second: index,
        }),
      );
      await fs.writeFile(
        sessionFile,
        `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      const plan = await buildSessionResetBoundaryPlan({
        events: [],
        legacySessionFile: sessionFile,
        reason: "new",
      });

      expect(plan.seedEvents).toHaveLength(6);
      expect(plan.seedEvents.map((entry) => (entry as { id?: string }).id)).toEqual(
        records.slice(-6).map((entry) => entry.id),
      );
      expect(plan.event.firstKeptEntryId).toBe("message-14");

      const metadataOnlyPlan = await buildSessionResetBoundaryPlan({
        events: [{ type: "model_change", id: "metadata-only", parentId: null }],
        legacySessionFile: sessionFile,
        reason: "new",
      });
      expect(metadataOnlyPlan.seedEvents).toHaveLength(6);
      expect(metadataOnlyPlan.event.firstKeptEntryId).toBe("message-14");
    });
  });

  it("respects legacy reset cuts and reparents the selected tail", async () => {
    await withTempDir({ prefix: "openclaw-reset-boundary-" }, async (dir) => {
      const sessionFile = path.join(dir, "legacy-reset.jsonl");
      const oldUser = message({
        id: "legacy-old-user",
        parentId: null,
        role: "user",
        content: "discarded",
        second: 1,
      });
      const oldAssistant = message({
        id: "legacy-old-assistant",
        parentId: oldUser.id,
        role: "assistant",
        content: "discarded answer",
        second: 2,
      });
      const keptUser = message({
        id: "legacy-kept-user",
        parentId: oldAssistant.id,
        role: "user",
        content: "kept",
        second: 3,
      });
      const toolResult = {
        type: "message",
        id: "legacy-tool-result",
        parentId: keptUser.id,
        timestamp: "2026-07-22T00:00:04.000Z",
        message: { role: "toolResult", content: "tool" },
      };
      const keptAssistant = message({
        id: "legacy-kept-assistant",
        parentId: toolResult.id,
        role: "assistant",
        content: "kept answer",
        second: 5,
      });
      const reset = {
        type: "reset",
        id: "legacy-reset",
        parentId: keptAssistant.id,
        timestamp: "2026-07-22T00:00:06.000Z",
        reason: "new",
        firstKeptEntryId: keptUser.id,
      };
      await fs.writeFile(
        sessionFile,
        `${[oldUser, oldAssistant, keptUser, toolResult, keptAssistant, reset]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      );

      const plan = await buildSessionResetBoundaryPlan({
        events: [],
        legacySessionFile: sessionFile,
        reason: "reset",
      });

      expect(plan.seedEvents).toEqual([
        expect.objectContaining({ id: keptUser.id, parentId: null }),
        expect.objectContaining({ id: keptAssistant.id, parentId: keptUser.id }),
      ]);
      expect(JSON.stringify(plan.seedEvents)).not.toContain("discarded");
      expect(plan.event.firstKeptEntryId).toBe(keptUser.id);
    });
  });
});

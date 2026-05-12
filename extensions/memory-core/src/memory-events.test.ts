import fs from "node:fs/promises";
import path from "node:path";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { describe, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

describe("memory host event journal integration", () => {
  it("records recall and promotion events from short-term promotion flows", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-events-");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily\n\nalpha\nbeta\ngamma\n",
      "utf8",
    );

    await recordShortTermRecalls({
      workspaceDir,
      query: "alpha memory",
      results: [
        {
          path: "memory/2026-04-05.md",
          startLine: 3,
          endLine: 4,
          score: 0.92,
          snippet: "alpha beta",
          source: "memory",
        },
      ],
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.UTC(2026, 3, 5, 12, 5, 0),
    });
    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.UTC(2026, 3, 5, 12, 10, 0),
    });

    expect(applied.applied).toBe(1);

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(events.map((event) => event.type)).toEqual([
      "memory.recall.recorded",
      "memory.promotion.applied",
    ]);
    const recallEvent = events[0];
    if (recallEvent?.type !== "memory.recall.recorded") {
      throw new Error("expected recall event");
    }
    expect(recallEvent.resultCount).toBe(1);
    expect(recallEvent.query).toBe("alpha memory");
    const promotionEvent = events[1];
    if (promotionEvent?.type !== "memory.promotion.applied") {
      throw new Error("expected promotion event");
    }
    expect(promotionEvent.applied).toBe(1);
  });

  it("records dreaming completion events when phase artifacts are written", async () => {
    const workspaceDir = await createTempWorkspace("memory-core-dream-events-");

    const written = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- staged note", "- second note"],
      nowMs: Date.UTC(2026, 3, 5, 13, 0, 0),
      storage: { mode: "both", separateReports: true },
    });

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(written.inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    expect(written.reportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
    );
    await expect(fs.readFile(written.inlinePath ?? "", "utf8")).resolves.toContain("- staged note");
    await expect(fs.readFile(written.reportPath ?? "", "utf8")).resolves.toContain("- second note");
    expect(events).toHaveLength(1);
    const dreamEvent = events[0];
    if (dreamEvent?.type !== "memory.dream.completed") {
      throw new Error("expected dream completion event");
    }
    expect(dreamEvent.phase).toBe("light");
    expect(dreamEvent.lineCount).toBe(2);
    expect(dreamEvent.storageMode).toBe("both");
  });
});

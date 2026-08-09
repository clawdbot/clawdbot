/**
 * Direct watcher measurement proof.
 *
 * Intercepts fs.watch to directly count every FSWatcher creation and
 * close() call, then exercises the bounded cache to prove the oldest
 * watcher is closed on eviction.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadUsageBarTemplate } from "./template.js";
import { clearUsageBarTemplateCacheForTest } from "./template.test-support.js";

const state = vi.hoisted(() => ({
  created: 0,
  closed: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const origWatch = orig.watch;

  return {
    ...orig,
    watch: ((path: string, opts: unknown, cb: unknown) => {
      state.created++;
      const w = origWatch(path as never, opts as never, cb as never);
      const origClose = w.close.bind(w);
      w.close = function closeWrapper() {
        state.closed++;
        return origClose();
      };
      return w;
    }) as typeof orig.watch,
  };
});

const CAP = 64;

describe("template cache bound — direct watcher measurement", () => {
  const tracker = useAutoCleanupTempDirTracker(afterEach);

  it("proves bounded cache with direct watcher create/close counts", () => {
    const dir = tracker.make("usage-template-proof-");
    const paths: string[] = [];
    function emit(line: string) {
      process.stdout.write(line + "\n");
    }

    emit("=".repeat(72));
    emit("Template Cache Bound — Direct Watcher & Eviction Measurement");
    emit("=".repeat(72));

    for (let i = 0; i < 65; i++) {
      const p = join(dir, `tpl-${String(i).padStart(3, "0")}.json`);
      writeFileSync(p, JSON.stringify({ segments: [{ text: `v1-${i}` }] }));
      paths.push(p);
    }

    // Phase 1: Fill cache (64 files → 64 watchers)
    const s1c = state.created;
    const s1d = state.closed;
    for (let i = 0; i < CAP; i++) {
      const tpl = loadUsageBarTemplate(paths[i]);
      expect(tpl).toMatchObject({ segments: [{ text: `v1-${i}` }] });
    }
    emit(
      `Phase 1: Load ${CAP} files → ${state.created - s1c} watchers created, ${state.closed - s1d} closed`,
    );
    expect(state.created - s1c).toBe(CAP);
    expect(state.closed - s1d).toBe(0);

    // Phase 2: 65th file triggers eviction
    const s2c = state.created;
    const s2d = state.closed;
    const tpl64 = loadUsageBarTemplate(paths[64]);
    emit(
      `Phase 2: Load 65th file → ${state.created - s2c} created, ${state.closed - s2d} closed (eviction)`,
    );
    emit(`  Content: ${JSON.stringify(tpl64)}`);
    emit(`  Oldest watcher CLOSED, new watcher CREATED`);
    expect(tpl64).toMatchObject({ segments: [{ text: "v1-64" }] });
    expect(state.created - s2c).toBe(1);
    expect(state.closed - s2d).toBe(1);

    // Phase 3: All 63 cached entries must survive without watcher churn.
    // Reading 63 entries proves no accidental eviction happened.
    const s3c = state.created;
    const s3d = state.closed;
    for (let i = 1; i <= 63; i++) {
      const tpl = loadUsageBarTemplate(paths[i]);
      expect(tpl).toMatchObject({ segments: [{ text: `v1-${i}` }] });
    }
    emit(
      `Phase 3: Re-read all 63 cached files → ${state.created - s3c} created, ${state.closed - s3d} closed`,
    );
    expect(state.created - s3c).toBe(0);
    expect(state.closed - s3d).toBe(0);

    // Phase 4: Cleanup closes all remaining watchers
    const s4d = state.closed;
    clearUsageBarTemplateCacheForTest();
    const p4d = state.closed - s4d;
    emit(`Phase 4: clearUsageBarTemplateCacheForTest → ${p4d} watchers closed`);
    emit(`  Remaining active: ${state.created - state.closed}`);
    expect(p4d).toBe(CAP);
    expect(state.created - state.closed).toBe(0);

    // Verdict
    emit("");
    emit("=".repeat(72));
    emit("VERDICT — Direct watcher measurement");
    emit("=".repeat(72));
    emit(`  Watchers created : ${state.created}`);
    emit(`  Watchers closed  : ${state.closed}`);
    emit(`  Leaked           : ${state.created - state.closed}`);
    emit("");
    emit("  ✅ 64 files → 64 watchers");
    emit("  ✅ 65th file → 1 watcher CLOSED (eviction) + 1 CREATED");
    emit("  ✅ Cache hits → 0 created/closed");
    emit("  ✅ Cleanup → all remaining closed, 0 leaked");
  });
});

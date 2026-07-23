import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";

const mocks = vi.hoisted(() => ({
  cleanupSessionArchivedTranscriptFiles: vi.fn(),
}));

vi.mock("./session-accessor.js", () => ({
  cleanupSessionArchivedTranscriptFiles: mocks.cleanupSessionArchivedTranscriptFiles,
}));

import { SessionArchiveCleanupPreviewCoordinator } from "./cleanup-archive.js";

const maintenance: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
  modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
  resetArchiveRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxDiskBytes: null,
  highWaterBytes: null,
};

function target(agentId: string, storePath: string): SessionStoreTarget {
  return { agentId, storePath };
}

describe("SessionArchiveCleanupPreviewCoordinator", () => {
  beforeEach(() => {
    mocks.cleanupSessionArchivedTranscriptFiles.mockReset();
    mocks.cleanupSessionArchivedTranscriptFiles.mockImplementation(
      async (params: { dryRun?: boolean; onRemoveFile?: (canonicalPath: string) => void }) => {
        if (params.dryRun) {
          params.onRemoveFile?.(path.resolve("/tmp/shared/stale.jsonl.deleted.2026-01-01"));
        }
        return { scanned: 1, removed: 1 };
      },
    );
  });

  it("previews and applies cleanup when the selected target owns the directory", async () => {
    const selected = target("main", "/tmp/explicit/sessions.json");
    const coordinator = new SessionArchiveCleanupPreviewCoordinator({
      selectedTargets: [selected],
      knownTargets: [selected],
    });

    const preview = await coordinator.preview({ target: selected, maintenance });
    const applied = await coordinator.apply({ target: selected, maintenance });

    expect(preview.report).toEqual({ scannedFiles: 1, removedFiles: 1 });
    expect(applied).toEqual({ scannedFiles: 1, removedFiles: 1 });
    expect(mocks.cleanupSessionArchivedTranscriptFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        directories: [path.resolve("/tmp/explicit")],
        dryRun: true,
      }),
    );
    expect(mocks.cleanupSessionArchivedTranscriptFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        directories: [path.resolve("/tmp/explicit")],
        dryRun: false,
      }),
    );
  });

  it("skips a shared archive directory when not every configured owner is selected", async () => {
    const storePath = "/tmp/shared/sessions.json";
    const main = target("main", storePath);
    const work = target("work", storePath);
    const coordinator = new SessionArchiveCleanupPreviewCoordinator({
      selectedTargets: [main],
      knownTargets: [main, work],
    });

    await expect(coordinator.preview({ target: main, maintenance })).resolves.toEqual({
      report: { scannedFiles: 0, removedFiles: 0 },
      excludeCanonicalPaths: new Set(),
    });
    await expect(coordinator.apply({ target: main, maintenance })).resolves.toEqual({
      scannedFiles: 0,
      removedFiles: 0,
    });
    expect(mocks.cleanupSessionArchivedTranscriptFiles).not.toHaveBeenCalled();
  });

  it("deduplicates preview and apply when all shared-directory owners are selected", async () => {
    const storePath = "/tmp/shared/sessions.json";
    const main = target("main", storePath);
    const work = target("work", storePath);
    const coordinator = new SessionArchiveCleanupPreviewCoordinator({
      selectedTargets: [main, work],
      knownTargets: [main, work],
    });

    const mainPreview = await coordinator.preview({ target: main, maintenance });
    const workPreview = await coordinator.preview({ target: work, maintenance });
    const mainApplied = await coordinator.apply({ target: main, maintenance });
    const workApplied = await coordinator.apply({ target: work, maintenance });

    expect(mainPreview.report).toEqual({ scannedFiles: 1, removedFiles: 1 });
    expect(workPreview.report).toEqual({ scannedFiles: 0, removedFiles: 0 });
    expect(workPreview.excludeCanonicalPaths).toEqual(mainPreview.excludeCanonicalPaths);
    expect(mainApplied).toEqual({ scannedFiles: 1, removedFiles: 1 });
    expect(workApplied).toEqual({ scannedFiles: 0, removedFiles: 0 });
    expect(mocks.cleanupSessionArchivedTranscriptFiles).toHaveBeenCalledTimes(2);
  });
});

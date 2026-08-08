import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const maintenance: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
  modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
  resetArchiveRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxDiskBytes: null,
  highWaterBytes: null,
};

vi.mock("./store-maintenance-runtime.js", () => ({
  resolveMaintenanceConfig: () => maintenance,
}));

import { runSessionsCleanup } from "./cleanup-service.js";

describe("runSessionsCleanup archive ownership", () => {
  it("preserves a shared SQLite archive for one agent and cleans it for all agents", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "shared.sqlite");
      const archivePath = path.join(home, "work.jsonl.deleted.2026-01-01T00-00-00.000Z");
      await fs.writeFile(archivePath, "");
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      };

      const selected = await runSessionsCleanup({
        cfg,
        opts: { agent: "main", dryRun: true },
      });
      expect(selected.previewResults).toHaveLength(1);
      expect(selected.previewResults[0]?.summary.archiveCleanup).toEqual({
        scannedFiles: 0,
        removedFiles: 0,
        skipReason: "shared-directory-requires-all-agents",
      });
      await expect(fs.stat(archivePath)).resolves.toBeDefined();

      const allAgentsPreview = await runSessionsCleanup({
        cfg,
        opts: { allAgents: true, dryRun: true },
      });
      expect(allAgentsPreview.previewResults).toHaveLength(1);
      expect(allAgentsPreview.previewResults[0]?.summary.archiveCleanup).toEqual({
        scannedFiles: 1,
        removedFiles: 1,
      });
      await expect(fs.stat(archivePath)).resolves.toBeDefined();

      const allAgentsApply = await runSessionsCleanup({
        cfg,
        opts: { allAgents: true },
      });
      expect(allAgentsApply.appliedSummaries).toHaveLength(1);
      expect(allAgentsApply.appliedSummaries[0]?.archiveCleanup).toEqual({
        scannedFiles: 1,
        removedFiles: 1,
      });
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves archives when shared SQLite stores use symlinked directories",
    async () => {
      await withTempHome(async (home) => {
        const mainDir = path.join(home, "main");
        const workDir = path.join(home, "work");
        await fs.mkdir(mainDir);
        await fs.symlink(mainDir, workDir, "dir");
        const archivePath = path.join(mainDir, "work.jsonl.deleted.2026-01-01T00-00-00.000Z");
        await fs.writeFile(archivePath, "");
        const cfg: OpenClawConfig = {
          session: { store: path.join(home, "{agentId}", "shared.sqlite") },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        };

        const selected = await runSessionsCleanup({
          cfg,
          opts: { agent: "main", dryRun: true },
        });
        expect(selected.previewResults).toHaveLength(1);
        expect(selected.previewResults[0]?.summary.archiveCleanup).toEqual({
          scannedFiles: 0,
          removedFiles: 0,
          skipReason: "shared-directory-requires-all-agents",
        });
        await expect(fs.stat(archivePath)).resolves.toBeDefined();

        const allAgentsPreview = await runSessionsCleanup({
          cfg,
          opts: { allAgents: true, dryRun: true },
        });
        expect(allAgentsPreview.previewResults).toHaveLength(1);
        expect(allAgentsPreview.previewResults[0]?.summary.archiveCleanup).toEqual({
          scannedFiles: 1,
          removedFiles: 1,
        });
        await expect(fs.stat(archivePath)).resolves.toBeDefined();

        const allAgentsApply = await runSessionsCleanup({
          cfg,
          opts: { allAgents: true },
        });
        expect(allAgentsApply.appliedSummaries).toHaveLength(1);
        expect(allAgentsApply.appliedSummaries[0]?.archiveCleanup).toEqual({
          scannedFiles: 1,
          removedFiles: 1,
        });
        await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});

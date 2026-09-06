import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Real-behavior proof: after-fix memory status displays the skipped symlink root
// while ordinary files remain eligible.
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanMemoryManagerSources } from "../cli-runtime-common.js";
import { inspectMemorySourceState } from "./manager-source-state.js";

describe("symlink extra-path root real-behavior proof", () => {
  let tmpRoot: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-symlink-proof-"));
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "deep status reports the skipped symlink root while ordinary memory files remain eligible",
    async () => {
      // Set up a workspace with ordinary memory files AND a symlink extra-path root.
      const memoryDir = path.join(tmpRoot, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "notes.md"), "# Ordinary note");

      // Create a real vault and a symlink pointing to it.
      const vaultDir = path.join(tmpRoot, "vault");
      const linkDir = path.join(tmpRoot, "obsidian");
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, "secret.md"), "# Linked vault note");
      fs.symlinkSync(vaultDir, linkDir, "dir");

      // 1. inspectMemorySourceState surfaces the skipped symlink root.
      const inspection = await inspectMemorySourceState({
        db,
        workspaceDir: tmpRoot,
        settings: {
          extraPaths: [{ path: "obsidian" }],
          multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
        },
        concurrency: 1,
      });

      // The ordinary memory file is eligible; the symlink root is skipped.
      expect(inspection.eligible).toBe(1);
      expect(inspection.issues).toContain(
        `symlink root: ${linkDir} — configure the canonical absolute directory instead; symlink roots are skipped to preserve the filesystem trust boundary`,
      );

      // 2. Simulate the manager merging inspections into sourceCounts, then
      //    feed it through scanMemoryManagerSources exactly as the CLI does.
      const status = {
        sourceCounts: [
          {
            source: "memory" as const,
            files: inspection.eligible ?? 0,
            chunks: 0,
            chunkBytes: 0,
            eligible: inspection.eligible,
            issues: inspection.issues,
          },
        ],
      } as unknown as Parameters<typeof scanMemoryManagerSources>[0];

      const scan = (await scanMemoryManagerSources(status))!;

      // 3. The CLI Issues section would render these.
      const renderedIssues = scan.issues;
      expect(renderedIssues).toContain(
        `symlink root: ${linkDir} — configure the canonical absolute directory instead; symlink roots are skipped to preserve the filesystem trust boundary`,
      );

      // Print the simulated CLI output for the PR evidence trail.
      // eslint-disable-next-line no-console
      console.log(
        [
          "memory status (deep) — simulated CLI output",
          "===============================================",
          `Source: memory`,
          `  Eligible: ${inspection.eligible}`,
          `Issues`,
          ...renderedIssues.map((issue) => `  ${issue}`),
          "===============================================",
        ].join("\n"),
      );
    },
  );
});

// Memory Core tests cover manager source state plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResolvedMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectMemorySourceState,
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";

describe("memory source state", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    const insert = db.prepare(
      "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("memory/one.md", "memory", "hash-1", 100.25, 10);
    insert.run("memory/two.md", "memory", "hash-2", 200.5, 20);
    insert.run("memory/one.md", "sessions", "session-hash", 300.75, 30);
  });

  afterEach(() => db.close());

  it("loads complete indexed rows for the requested source", () => {
    expect(loadMemorySourceFileState({ db, source: "memory" })).toEqual([
      { path: "memory/one.md", hash: "hash-1", mtime: 100.25, size: 10 },
      { path: "memory/two.md", hash: "hash-2", mtime: 200.5, size: 20 },
    ]);
    db.prepare("DELETE FROM memory_index_sources WHERE source = ?").run("memory");
    expect(loadMemorySourceFileState({ db, source: "memory" })).toEqual([]);
  });

  it.each([
    { paths: [], expected: [] },
    { paths: ["memory/one.md", "memory/one.md", "missing' OR 1=1 --"], expected: ["hash-1"] },
    {
      paths: [...Array.from({ length: 33_000 }, (_, index) => `missing-${index}`), "memory/one.md"],
      expected: ["hash-1"],
    },
  ])("restricts source snapshots to $paths.length requested paths", ({ paths, expected }) => {
    expect(
      loadMemorySourceFileState({ db, source: "memory", paths }).map((row) => row.hash),
    ).toEqual(expected);
  });

  it.each([
    {
      existingHashes: new Map([["memory/one.md", "hash-from-snapshot"]]),
      expected: "hash-from-snapshot",
    },
    { existingHashes: new Map<string, string>(), expected: undefined },
  ])(
    "uses the bulk snapshot without consulting newer rows: $expected",
    ({ existingHashes, expected }) => {
      expect(
        resolveMemorySourceExistingHash({
          db,
          source: "memory",
          path: "memory/one.md",
          existingHashes,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    { source: "memory" as const, path: "memory/one.md", expected: "hash-1" },
    { source: "sessions" as const, path: "memory/one.md", expected: "session-hash" },
    { source: "sessions" as const, path: "memory/missing.md", expected: undefined },
  ])(
    "reads the current $source row for $path without a snapshot",
    ({ source, path: rowPath, expected }) => {
      expect(resolveMemorySourceExistingHash({ db, source, path: rowPath })).toBe(expected);
    },
  );
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const disabledMultimodal = { enabled: false, modalities: [], maxFileBytes: 0 };

type InspectionSettings = Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal">;

async function inspectExtraPaths(params: {
  workspaceDir: string;
  settings: InspectionSettings;
}): Promise<{ eligible: number | null; issues: string[] }> {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
  const inspection = await inspectMemorySourceState({
    db,
    workspaceDir: params.workspaceDir,
    settings: params.settings,
    concurrency: 2,
  });
  db.close();
  return { eligible: inspection.eligible, issues: inspection.issues };
}

describe("memory source inspection extra-path diagnostics", () => {
  it.skipIf(process.platform === "win32")(
    "names a symlinked extra-path root that contributes nothing while canonical memory stays healthy",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-memory-source-symlink-");
      // The vault root must come from the tracker: a sibling of the allocated
      // workspace would escape cleanup and be shared across runs.
      const vaultDir = tempDirs.make("openclaw-memory-source-vault-");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "# Canonical\n");
      await fs.writeFile(path.join(vaultDir, "vault-note.md"), "# Vault\n");
      await fs.symlink(vaultDir, path.join(workspaceDir, "obsidian"), "dir");

      const inspection = await inspectExtraPaths({
        workspaceDir,
        settings: { extraPaths: [{ path: "obsidian" }], multimodal: disabledMultimodal },
      });

      expect(inspection.eligible).toBe(1);
      const symlinkIssue = inspection.issues.find(
        (issue) => issue.includes("obsidian") && issue.includes("symlink"),
      );
      expect(symlinkIssue).toBeDefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "names the symlink root even when it is the only configured source",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-memory-source-symlink-only-");
      const vaultDir = tempDirs.make("openclaw-memory-source-vault-");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(vaultDir, "vault-note.md"), "# Vault\n");
      await fs.symlink(vaultDir, path.join(workspaceDir, "obsidian"), "dir");

      const inspection = await inspectExtraPaths({
        workspaceDir,
        settings: { extraPaths: [{ path: "obsidian" }], multimodal: disabledMultimodal },
      });

      expect(inspection.eligible).toBe(0);
      const symlinkIssue = inspection.issues.find(
        (issue) => issue.includes("obsidian") && issue.includes("symlink"),
      );
      expect(symlinkIssue).toBeDefined();
      expect(inspection.issues).toContain("no eligible memory files found");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps healthy extra-path roots free of symlink diagnostics",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-memory-source-healthy-");
      const vaultDir = path.join(workspaceDir, "obsidian");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.mkdir(vaultDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "# Canonical\n");
      await fs.writeFile(path.join(vaultDir, "vault-note.md"), "# Vault\n");

      const inspection = await inspectExtraPaths({
        workspaceDir,
        settings: { extraPaths: [{ path: "obsidian" }], multimodal: disabledMultimodal },
      });

      expect(inspection.eligible).toBe(2);
      expect(inspection.issues).toEqual([]);
    },
  );
});

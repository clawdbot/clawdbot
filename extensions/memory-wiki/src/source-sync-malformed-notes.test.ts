import fs from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryWikiSourceSyncStateStore,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const tempDirs = createMemoryWikiTestHarness();

function createImportedSourceState(pagePath: string, group: MemoryWikiImportedSourceGroup) {
  return {
    version: 1 as const,
    entries: {
      "sync-key": {
        group,
        pagePath,
        sourcePath: "/tmp/source.md",
        sourceUpdatedAtMs: 0,
        sourceSize: 0,
        renderFingerprint: "fp",
      },
    },
  };
}

describe("memory wiki source sync malformed human Notes", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
  });

  it.each([
    { group: "bridge" as const, missingMarker: "opening" as const },
    { group: "bridge" as const, missingMarker: "closing" as const },
    { group: "bridge" as const, missingMarker: "both" as const },
    { group: "unsafe-local" as const, missingMarker: "opening" as const },
    { group: "unsafe-local" as const, missingMarker: "closing" as const },
    { group: "unsafe-local" as const, missingMarker: "both" as const },
  ])(
    "preserves $group pages and persisted state when the $missingMarker marker is missing",
    async ({ group, missingMarker }) => {
      const stateDir = await tempDirs.createTempDir("memory-wiki-malformed-notes-");
      const vaultRoot = path.join(stateDir, "vault");
      const pagePath = `sources/${group}-missing-${missingMarker}.md`;
      const pageAbsPath = path.join(vaultRoot, pagePath);
      await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
      const pageContent = [
        group === "bridge" ? "# Memory Bridge (test)" : "# Unsafe Local Import: test",
        "## Content",
        "```",
        "generated content",
        "```",
        "## Notes",
        ...(missingMarker === "opening" || missingMarker === "both"
          ? []
          : ["<!-- openclaw:human:start -->"]),
        "human annotations must survive malformed markers",
        ...(missingMarker === "closing" || missingMarker === "both"
          ? []
          : ["<!-- openclaw:human:end -->"]),
        "",
      ].join("\n");
      await fs.writeFile(pageAbsPath, pageContent, "utf8");

      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const store = createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
      );
      const initialState = createImportedSourceState(pagePath, group);
      await writeMemoryWikiSourceSyncState(vaultRoot, initialState, store);
      const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
      const entry = state.entries["sync-key"]!;
      const updatedEntry = { ...entry, sourceSize: entry.sourceSize + 1 };
      setImportedSourceEntry({ state, syncKey: "sync-key", entry: updatedEntry });
      const expectedMissingMarker =
        missingMarker === "opening" || missingMarker === "both"
          ? "<!-- openclaw:human:start -->"
          : "<!-- openclaw:human:end -->";

      await expect(
        pruneImportedSourceEntries({
          vaultRoot,
          group,
          activeKeys: new Set(),
          state,
        }),
      ).rejects.toThrow(expectedMissingMarker);

      expect(state.entries["sync-key"]).toEqual(updatedEntry);
      await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual(initialState);
      await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toBe(pageContent);
      await expect(fs.access(path.join(vaultRoot, ".salvage"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeMemoryWikiSourceSyncState(vaultRoot, state, store);
      await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toMatchObject({
        entries: { "sync-key": updatedEntry },
      });
    },
  );

  it("rejects pruning an oversized source page with an unclosed human Notes marker", async () => {
    const vaultRoot = await tempDirs.createTempDir("memory-wiki-malformed-notes-");
    const pagePath = "sources/oversized-missing-closing-marker.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Memory Bridge (test)",
        "## Content",
        "```",
        "x".repeat(16 * 1024 * 1024),
        "```",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "oversized annotations must survive malformed markers",
        "",
      ].join("\n"),
      "utf8",
    );
    const state = createImportedSourceState(pagePath, "bridge");

    await expect(
      pruneImportedSourceEntries({
        vaultRoot,
        group: "bridge",
        activeKeys: new Set(),
        state,
      }),
    ).rejects.toThrow("<!-- openclaw:human:end -->");

    expect(state.entries["sync-key"]).toBeDefined();
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isFile());
    await expect(fs.access(path.join(vaultRoot, ".salvage"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

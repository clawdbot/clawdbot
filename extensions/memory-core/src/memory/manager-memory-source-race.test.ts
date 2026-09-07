import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory source changes during indexing", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([
    ...["batch-test", "batch-wide-test"].flatMap((provider) =>
      [false, true].flatMap((force) =>
        ["change", "delete"].map((mutation) => ({ provider, force, mutation, maintenance: false })),
      ),
    ),
    ...["change", "delete"].map((mutation) => ({
      provider: "batch-test",
      force: true,
      mutation,
      maintenance: true,
    })),
  ])(
    "keeps $mutation local during $provider indexing (force=$force, maintenance=$maintenance)",
    async ({ provider, force, mutation, maintenance }) => {
      const changingFile = path.join(fixture.paths.memory, "changing.md");
      const siblingFile = path.join(fixture.paths.memory, "sibling.md");
      await fs.writeFile(changingFile, "Original alpha source.");
      await fs.writeFile(siblingFile, "Original beta sibling.");
      const cfg = fixture.createConfig({
        provider,
        batchEnabled: true,
        vectorEnabled: false,
        sources: ["memory"],
      });
      cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
      const manager = await fixture.getFreshManager(cfg, "cli");
      await manager.sync({ reason: "baseline", force: true });
      await fs.writeFile(changingFile, "Obsolete alpha source awaiting embeddings.");
      await fs.writeFile(siblingFile, "Updated beta sibling survives the concurrent edit.");
      Reflect.set(manager, "dirty", true);
      let releaseEmbedding = () => {};
      const embeddingGate = new Promise<void>((resolve) => {
        releaseEmbedding = resolve;
      });
      let changingSourceEntered = () => {};
      const changingSourceReady = new Promise<void>((resolve) => {
        changingSourceEntered = resolve;
      });
      fixture.provider.providerRuntimeBatchEntered = (_activeCalls, texts) => {
        if (texts.some((text) => text.includes("Obsolete alpha source"))) {
          fixture.provider.providerRuntimeBatchGate = embeddingGate;
          changingSourceEntered();
        }
      };
      if (maintenance) {
        Reflect.set(manager, "memoryFullRetryDirty", true);
      }
      const activeSync = maintenance
        ? (
            manager as unknown as {
              syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
            }
          ).syncPublishedIndexInBackground({ reason: "search" })
        : manager.sync({ reason: "watch", force });
      void activeSync.catch(() => undefined);
      try {
        await Promise.race([changingSourceReady, activeSync]);
        expect(fixture.provider.providerRuntimeBatchGate).toBe(embeddingGate);
        if (!maintenance) {
          expect(manager.status().dirty).toBe(true);
        }
        if (mutation === "delete") {
          await fs.unlink(changingFile);
        } else {
          await fs.writeFile(changingFile, "Latest alpha source after the concurrent edit.");
        }
        releaseEmbedding();
        await expect(activeSync).resolves.toBeUndefined();
        const db = Reflect.get(manager, "db") as DatabaseSync;
        const indexedText = () =>
          db
            .prepare("SELECT text FROM memory_index_chunks")
            .all()
            .map((row) => row.text)
            .join("\n");
        expect(indexedText()).toContain("Updated beta sibling");
        expect(indexedText()).not.toContain("Obsolete alpha");
        expect(manager.status().dirty).toBe(true);
        expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(false);

        fixture.provider.providerRuntimeBatchCalls = [];
        await manager.sync({ reason: "retry-source" });
        expect(manager.status().dirty).toBe(false);
        expect(indexedText()).toContain("Updated beta sibling");
        expect(indexedText()).not.toContain("Obsolete alpha");
        if (mutation === "delete") {
          expect(
            db
              .prepare("SELECT path FROM memory_index_sources WHERE path = ?")
              .get("memory/changing.md"),
          ).toBeUndefined();
        } else {
          expect(indexedText()).toContain("Latest alpha source");
        }
        expect(fixture.provider.providerRuntimeBatchCalls.flat().join("\n")).not.toContain(
          "beta sibling",
        );
      } finally {
        releaseEmbedding();
        await activeSync.catch(() => undefined);
        fixture.provider.providerRuntimeBatchGate = null;
        fixture.provider.providerRuntimeBatchEntered = null;
      }
    },
  );
});

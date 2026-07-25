// Memory Wiki tests cover ingest plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { describe, expect, it, vi } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ingestMemoryWikiSource", () => {
  it("copies a local text file into sources markdown", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    await fs.writeFile(inputPath, "hello from source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });

    const result = await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.pageId).toBe("source.meeting-notes");
    expect(result.pagePath).toBe("sources/meeting-notes.md");
    expect(result.indexUpdatedFiles.length).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(config.vault.path, "sources", "meeting-notes.md"), "utf8"))
      .resolves.toBe(`---
pageType: source
id: source.meeting-notes
title: meeting notes
sourceType: local-file
sourcePath: ${inputPath}
ingestedAt: 2026-04-05T12:00:00.000Z
updatedAt: 2026-04-05T12:00:00.000Z
status: active
---

# meeting notes

## Source
- Type: \`local-file\`
- Path: \`${inputPath}\`
- Bytes: 18
- Updated: 2026-04-05T12:00:00.000Z

## Content
\`\`\`text
hello from source

\`\`\`

## Notes
<!-- openclaw:human:start -->
<!-- openclaw:human:end -->

## Related
<!-- openclaw:wiki:related:start -->
- No related pages yet.
<!-- openclaw:wiki:related:end -->
`);
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      "[meeting notes](sources/meeting-notes.md)",
    );
  });

  it("queues behind a held vault mutation instead of writing mid-transaction", async () => {
    const rootDir = await createTempDir("memory-wiki-ingest-lock-");
    const inputPath = path.join(rootDir, "meeting-notes.txt");
    await fs.writeFile(inputPath, "hello from source\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(rootDir, "vault"),
    });
    const pagePath = path.join(config.vault.path, "sources", "meeting-notes.md");

    const lockEntered = deferred();
    const releaseLock = deferred();
    const holder = withMemoryWikiVaultMutation(config.vault.path, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    const ingestQueued = deferred();
    const originalEnqueue = Object.getOwnPropertyDescriptor(KeyedAsyncQueue.prototype, "enqueue")
      ?.value as KeyedAsyncQueue["enqueue"];
    const enqueueSpy = vi
      .spyOn(KeyedAsyncQueue.prototype, "enqueue")
      .mockImplementation(function (this: KeyedAsyncQueue, key, task, hooks) {
        ingestQueued.resolve();
        return originalEnqueue.call(this, key, task, hooks);
      });
    let ingest: ReturnType<typeof ingestMemoryWikiSource> | undefined;
    try {
      ingest = ingestMemoryWikiSource({
        config,
        inputPath,
        nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
      });
      // On fixed code this observes ingest joining the held queue before any
      // filesystem work. On unfixed code it observes nested compile only after
      // the source page was already written, so the assertion fails.
      await ingestQueued.promise;
      await expect(fs.access(pagePath)).rejects.toThrow();

      releaseLock.resolve();
      // Completion also proves the nested compile re-enters the held vault
      // lock reentrantly instead of deadlocking.
      const result = await ingest;
      await holder;
      expect(result.created).toBe(true);
      await expect(fs.readFile(pagePath, "utf8")).resolves.toContain("hello from source");
    } finally {
      releaseLock.resolve();
      enqueueSpy.mockRestore();
      await Promise.allSettled([holder, ...(ingest ? [ingest] : [])]);
    }
  });
});

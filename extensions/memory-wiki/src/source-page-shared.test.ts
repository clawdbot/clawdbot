// Memory Wiki tests cover source page shared plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeImportedSourcePage } from "./source-page-shared.js";

describe("writeImportedSourcePage", () => {
  let suiteRoot: string;

  beforeEach(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(suiteRoot, { recursive: true, force: true });
  });

  it("falls back when the source mtime is outside the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const sourcePath = path.join(suiteRoot, "source.txt");
    await fs.writeFile(sourcePath, "source body", "utf8");
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    const result = await writeImportedSourcePage({
      vaultRoot: suiteRoot,
      syncKey: "unsafe:source",
      sourcePath,
      sourceUpdatedAtMs: 8_700_000_000_000_000,
      sourceSize: 11,
      renderFingerprint: "fingerprint",
      pagePath: "pages/source.md",
      group: "unsafe-local",
      state,
      buildRendered: (raw, updatedAt) => `updatedAt: ${updatedAt}\n${raw}`,
    });

    await expect(fs.readFile(path.join(suiteRoot, "pages/source.md"), "utf8")).resolves.toBe(
      "updatedAt: 2026-05-01T12:00:00.000Z\nsource body",
    );
    expect(result).toEqual({ pagePath: "pages/source.md", changed: true, created: true });
    expect(state.entries["unsafe:source"]?.sourceUpdatedAtMs).toBe(8_700_000_000_000_000);
  });
});

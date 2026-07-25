// Session-store temp cleanup tests cover startup reclamation and recovery boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { SESSION_STORE_TEMP_STALE_MS } from "./artifacts.js";
import { sweepOrphanSessionStoreTemps } from "./store-temp-cleanup.js";

const UUID = "0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const NOW_MS = 2_000_000_000_000;

async function writeAt(filePath: string, contents: string, mtimeMs: number): Promise<void> {
  await fs.writeFile(filePath, contents);
  await fs.utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe("sweepOrphanSessionStoreTemps", () => {
  it("removes stale current and legacy temps while preserving fresh and unrelated files", async () => {
    await withTempDir({ prefix: "store-temp-cleanup" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const staleMtime = NOW_MS - SESSION_STORE_TEMP_STALE_MS - 1;
      const staleCurrent = `${storePath}.123.${UUID}.tmp`;
      const staleLegacy = `${storePath}.${UUID}.tmp`;
      const fresh = `${storePath}.456.${UUID}.tmp`;
      const unrelated = path.join(dir, `other.json.123.${UUID}.tmp`);
      await fs.writeFile(storePath, "{}");
      await Promise.all([
        writeAt(staleCurrent, "stale", staleMtime),
        writeAt(staleLegacy, "legacy", staleMtime),
        writeAt(fresh, "fresh", NOW_MS),
        writeAt(unrelated, "other", staleMtime),
      ]);

      await expect(sweepOrphanSessionStoreTemps({ storePath, nowMs: NOW_MS })).resolves.toBe(2);
      await expect(fs.stat(staleCurrent)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(staleLegacy)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(fresh, "utf8")).resolves.toBe("fresh");
      await expect(fs.readFile(unrelated, "utf8")).resolves.toBe("other");
    });
  });

  it.each([
    ["missing", undefined],
    ["corrupt", "{not-json"],
    ["non-record", "[]"],
  ])("preserves recovery candidates when the primary store is %s", async (_label, primary) => {
    await withTempDir({ prefix: "store-temp-recovery" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const candidate = `${storePath}.123.${UUID}.tmp`;
      if (primary !== undefined) {
        await fs.writeFile(storePath, primary);
      }
      await writeAt(candidate, "recoverable", NOW_MS - SESSION_STORE_TEMP_STALE_MS - 1);

      await expect(sweepOrphanSessionStoreTemps({ storePath, nowMs: NOW_MS })).resolves.toBe(0);
      await expect(fs.readFile(candidate, "utf8")).resolves.toBe("recoverable");
    });
  });

  it("matches a custom store basename", async () => {
    await withTempDir({ prefix: "store-temp-custom" }, async (dir) => {
      const storePath = path.join(dir, "custom-store.json");
      const candidate = `${storePath}.123.${UUID}.tmp`;
      await fs.writeFile(storePath, "{}");
      await writeAt(candidate, "stale", NOW_MS - SESSION_STORE_TEMP_STALE_MS - 1);

      await expect(sweepOrphanSessionStoreTemps({ storePath, nowMs: NOW_MS })).resolves.toBe(1);
      await expect(fs.stat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

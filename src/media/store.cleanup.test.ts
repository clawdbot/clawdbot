// cleanOldMedia must stay out of the SQLite-managed outgoing tree.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

describe("cleanOldMedia managed-subtree retention", () => {
  let store: typeof import("./store.js");
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    store = await import("./store.js");
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } catch {
      // ignore cleanup failures in tests
    }
  });

  it("keeps managed outgoing originals and legacy records during recursive cleanup", async () => {
    const original = await store.saveMediaBuffer(
      Buffer.from("history original"),
      "image/png",
      path.join("outgoing", "originals"),
    );
    const mediaDir = await store.ensureMediaDir();
    const recordPath = path.join(mediaDir, "outgoing", "records", "legacy.json");
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(recordPath, "{}");
    const past = Date.now() - 10_000;
    await fs.utimes(original.path, past / 1000, past / 1000);
    await fs.utimes(recordPath, past / 1000, past / 1000);

    await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

    expect((await fs.stat(original.path)).isFile()).toBe(true);
    expect((await fs.stat(recordPath)).isFile()).toBe(true);
    expect((await fs.stat(path.join(mediaDir, "outgoing"))).isDirectory()).toBe(true);
  });
});

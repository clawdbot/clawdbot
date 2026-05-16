import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { readSessionStoreReadOnly } from "./store-read.js";

describe("readSessionStoreReadOnly", () => {
  it("returns an empty store for malformed or non-object JSON", async () => {
    await withTempDir({ prefix: "openclaw-session-store-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");

      await fs.writeFile(storePath, '["not-an-object"]\n', "utf8");
      expect(readSessionStoreReadOnly(storePath)).toStrictEqual({});

      await fs.writeFile(storePath, '{"session-1":{"sessionId":"s1","updatedAt":1}}\n', "utf8");
      const store = readSessionStoreReadOnly(storePath);
      expect(store["session-1"]?.sessionId).toBe("s1");
      expect(store["session-1"]?.updatedAt).toBe(1);
    });
  });

  it("filters non-object entries from read-only session store snapshots", async () => {
    await withTempDir({ prefix: "openclaw-session-store-readonly-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");

      await fs.writeFile(
        storePath,
        JSON.stringify({
          good: { sessionId: "s-good", updatedAt: 1 },
          scalar: "bad",
          array: [{ sessionId: "s-array", updatedAt: 1 }],
        }),
        "utf8",
      );

      const store = readSessionStoreReadOnly(storePath);

      expect(store.good?.sessionId).toBe("s-good");
      expect(store.scalar).toBeUndefined();
      expect(store.array).toBeUndefined();
    });
  });

  it("filters invalid session ids and drops malformed sessionFile fields", async () => {
    await withTempDir({ prefix: "openclaw-session-store-readonly-shape-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");

      await fs.writeFile(
        storePath,
        JSON.stringify({
          good: { sessionId: " good-session ", updatedAt: "bad", sessionFile: ["bad"] },
          badId: { sessionId: { id: "bad" }, updatedAt: 1 },
          traversal: { sessionId: "../etc/passwd", updatedAt: 1 },
        }),
        "utf8",
      );

      const store = readSessionStoreReadOnly(storePath);

      expect(store.good?.sessionId).toBe("good-session");
      expect(store.good?.updatedAt).toBe(0);
      expect(store.good?.sessionFile).toBeUndefined();
      expect(store.badId).toBeUndefined();
      expect(store.traversal).toBeUndefined();
    });
  });
});

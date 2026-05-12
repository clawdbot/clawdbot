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
});

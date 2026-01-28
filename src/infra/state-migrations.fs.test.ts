import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readSessionStoreJson5 } from "./state-migrations.fs.js";

describe("state migrations fs", () => {
  it("treats array session stores as invalid", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "[]", "utf-8");

    const result = readSessionStoreJson5(storePath);
    expect(result.ok).toBe(false);
    expect(result.store).toEqual({});
  });
});

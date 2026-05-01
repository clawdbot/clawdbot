import { describe, expect, it, vi } from "vitest";

vi.mock("sqlite-vec", () => {
  throw new Error("bundled sqlite-vec should not load when extensionPath is explicit");
});

import { loadSqliteVecExtension } from "./sqlite-vec.js";

describe("loadSqliteVecExtension", () => {
  it("loads explicit extensionPath without importing bundled sqlite-vec", async () => {
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    await expect(
      loadSqliteVecExtension({
        db: db as never,
        extensionPath: "/opt/openclaw/sqlite-vec.so",
      }),
    ).resolves.toEqual({ ok: true, extensionPath: "/opt/openclaw/sqlite-vec.so" });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith("/opt/openclaw/sqlite-vec.so");
  });
});

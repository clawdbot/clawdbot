import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { close, configureSqliteConnectionPragmas } = vi.hoisted(() => ({
  close: vi.fn(),
  configureSqliteConnectionPragmas: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/sqlite-runtime", () => ({
  openNodeSqliteDatabase: vi.fn(() => ({ close })),
}));
vi.mock("openclaw/plugin-sdk/plugin-state-runtime", () => ({
  configureSqliteConnectionPragmas,
}));

import { createWorkboardSqliteStores } from "./sqlite-store.js";

describe("Workboard SQLite policy", () => {
  beforeEach(() => {
    close.mockClear();
    configureSqliteConnectionPragmas.mockReset();
  });

  it("closes a newly opened database when filesystem policy refuses it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-policy-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    configureSqliteConnectionPragmas.mockImplementation(() => {
      throw new Error("SSHFS is unsupported");
    });

    try {
      expect(() => createWorkboardSqliteStores({ dbPath })).toThrow(/SSHFS/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

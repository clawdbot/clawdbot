import { describe, expect, test, vi } from "vitest";

const lanceMocks = vi.hoisted(() => ({
  countRows: vi.fn(async () => 1),
  deleteRows: vi.fn(),
}));

vi.mock("./lancedb-runtime.js", () => ({
  loadLanceDbModule: vi.fn(async () => ({
    connect: vi.fn(async () => ({
      tableNames: vi.fn(async () => ["memories"]),
      openTable: vi.fn(async () => ({
        schema: vi.fn(async () => ({ fields: [{ name: "agentId" }] })),
        countRows: lanceMocks.countRows,
        delete: lanceMocks.deleteRows,
        close: vi.fn(),
      })),
      close: vi.fn(),
    })),
  })),
}));

import { MemoryDB } from "./lancedb-store.js";

describe("MemoryDB delete receipts", () => {
  test("uses LanceDB's deleted-row count as the authoritative receipt", async () => {
    const db = new MemoryDB("/unused", 3);
    const memoryId = "890e1fae-1234-4678-abcd-ef0123456789";
    lanceMocks.deleteRows
      .mockResolvedValueOnce({ numDeletedRows: 0, version: 1 })
      .mockResolvedValueOnce({ numDeletedRows: 1, version: 2 })
      .mockRejectedValueOnce(new Error("delete unavailable"));

    await expect(db.delete("main", memoryId)).resolves.toBe(false);
    await expect(db.delete("main", memoryId)).resolves.toBe(true);
    await expect(db.delete("main", memoryId)).rejects.toThrow("delete unavailable");
    expect(lanceMocks.countRows).not.toHaveBeenCalled();
    expect(lanceMocks.deleteRows).toHaveBeenCalledTimes(3);
  });
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function initializeInChild(dbPath: string): Promise<void> {
  const moduleUrl = new URL("./lancedb-store.ts", import.meta.url).href;
  const source = `
    import { MemoryDB } from ${JSON.stringify(moduleUrl)};
    const db = new MemoryDB(process.argv[1], 4);
    await db.count("concurrent-test-agent");
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source, dbPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`memory-lancedb initializer exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

describe("memory-lancedb concurrent initialization", () => {
  test("atomically creates the memories table across processes", async () => {
    const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-lancedb-race-"));
    tempDirs.push(dbPath);

    await Promise.all(Array.from({ length: 6 }, () => initializeInChild(dbPath)));

    const lancedb = await import("@lancedb/lancedb");
    const connection = await lancedb.connect(dbPath);
    await expect(connection.tableNames()).resolves.toEqual(["memories"]);
    const table = await connection.openTable("memories");
    await expect(table.countRows()).resolves.toBe(0);
  });
});

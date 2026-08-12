import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool, type EditOperations } from "./edit.js";
import type { EditToolDetails } from "./tool-contracts.js";

describe("edit tool concurrency", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function createTempFile(content: string | Buffer) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-tool-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async function statEditFile(absolutePath: string) {
    try {
      const stat = await fs.stat(absolutePath);
      return {
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  it("classifies identical concurrent edit followers as unchanged", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-tool-race-"));
    const tool = createEditTool(tmpDir);
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const filePath = path.join(tmpDir, `race-${iteration}.txt`);
      await fs.writeFile(filePath, "alpha\nbeta\ngamma\ndelta\n", "utf-8");
      const edits =
        iteration % 2 === 0
          ? [{ oldText: "beta", newText: "BETA" }]
          : [
              { oldText: "beta", newText: "BETA" },
              { oldText: "delta", newText: "DELTA" },
            ];
      const results = await Promise.all([
        tool.execute(`leader-${iteration}`, { path: filePath, edits }, undefined),
        tool.execute(`follower-${iteration}`, { path: filePath, edits }, undefined),
      ]);
      expect(
        results
          .map((result) => (result.details as EditToolDetails).changed)
          .toSorted((left, right) => Number(left) - Number(right)),
      ).toEqual([false, true]);
      await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
        iteration % 2 === 0 ? "alpha\nBETA\ngamma\ndelta\n" : "alpha\nBETA\ngamma\nDELTA\n",
      );
    }
  });

  it("keeps independent already-target edits as mismatches", async () => {
    const filePath = await createTempFile("alpha\nBETA\ngamma\n");
    const tool = createEditTool(tmpDir);
    await expect(
      tool.execute(
        "independent",
        {
          path: filePath,
          edits: [{ oldText: "beta", newText: "BETA" }],
        },
        undefined,
      ),
    ).rejects.toThrow("Could not find the exact text");
  });

  it("keeps non-identical concurrent edits as mismatches", async () => {
    const filePath = await createTempFile("alpha\nbeta\ngamma\n");
    const tool = createEditTool(tmpDir);
    const results = await Promise.allSettled([
      tool.execute(
        "first",
        { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] },
        undefined,
      ),
      tool.execute(
        "second",
        { path: filePath, edits: [{ oldText: "beta", newText: "Beta" }] },
        undefined,
      ),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toEqual(
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("Could not find the exact text"),
        }),
      }),
    );
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\nBETA\ngamma\n");
  });

  it("does not reuse a failed identical edit leader", async () => {
    const filePath = await createTempFile("alpha\nbeta\ngamma\n");
    let writeAttempts = 0;
    const operations: EditOperations = {
      access: (absolutePath) => fs.access(absolutePath),
      readFile: (absolutePath) => fs.readFile(absolutePath),
      statFile: statEditFile,
      writeFile: async (absolutePath, content) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw new Error("Simulated leader failure");
        }
        await fs.writeFile(absolutePath, content, "utf-8");
      },
    };
    const tool = createEditTool(tmpDir, { operations });
    const input = { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] };
    const results = await Promise.allSettled([
      tool.execute("leader", input, undefined),
      tool.execute("follower", input, undefined),
    ]);
    expect(results[0]).toEqual(
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ message: "Simulated leader failure" }),
      }),
    );
    expect(results[1].status).toBe("fulfilled");
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\nBETA\ngamma\n");
  });

  it("rechecks persisted bytes after an intervening different edit", async () => {
    const filePath = await createTempFile("alpha\nbeta\ngamma\n");
    const tool = createEditTool(tmpDir);
    const identical = { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] };
    const results = await Promise.allSettled([
      tool.execute("leader", identical, undefined),
      tool.execute(
        "intervening",
        { path: filePath, edits: [{ oldText: "BETA", newText: "Beta" }] },
        undefined,
      ),
      tool.execute("follower", identical, undefined),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("fulfilled");
    expect(results[2]).toEqual(
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("Could not find the exact text"),
        }),
      }),
    );
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("alpha\nBeta\ngamma\n");
  });

  it("preserves follower cancellation during persisted-byte verification", async () => {
    const filePath = await createTempFile("alpha\nbeta\ngamma\n");
    const controller = new AbortController();
    let statCalls = 0;
    const tool = createEditTool(tmpDir, {
      operations: {
        access: (absolutePath) => fs.access(absolutePath),
        readFile: (absolutePath) => fs.readFile(absolutePath),
        writeFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf-8"),
        statFile: async (absolutePath) => {
          const result = await statEditFile(absolutePath);
          if ((statCalls += 1) === 2) {
            controller.abort();
          }
          return result;
        },
      },
    });
    const input = { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] };
    const results = await Promise.allSettled([
      tool.execute("leader", input, undefined),
      tool.execute("follower", input, controller.signal),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toEqual(
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ message: "Operation aborted" }),
      }),
    );
  });
});

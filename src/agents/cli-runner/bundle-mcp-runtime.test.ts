import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

describe("writeTemporaryBundleMcpJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the file and its cleanup removes the temp dir", async () => {
    const { filePath, cleanup } = await writeTemporaryBundleMcpJson(
      "openclaw-runtime-test-",
      { mcpServers: {} },
      "mcp.json",
      false,
    );
    expect(path.basename(filePath)).toBe("mcp.json");
    await expect(fs.stat(filePath)).resolves.toBeDefined();
    await cleanup();
    await expect(fs.stat(path.dirname(filePath))).rejects.toThrow();
  });

  it("rolls the temp dir back when the write fails, leaving no leaked dir", async () => {
    // The shared writer owns rollback so every backend (Claude/Codex/Gemini)
    // gets the same guarantee: a failed write never leaks a temp dir.
    const created: string[] = [];
    const realMkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation((async (prefix: unknown, ...rest: unknown[]) => {
      const dir = (await (realMkdtemp as (...a: unknown[]) => Promise<unknown>)(
        prefix,
        ...rest,
      )) as string;
      created.push(dir);
      return dir;
    }) as typeof fs.mkdtemp);
    vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("simulated write failure"));

    await expect(
      writeTemporaryBundleMcpJson(
        "openclaw-runtime-rollback-",
        { mcpServers: {} },
        "mcp.json",
        false,
      ),
    ).rejects.toThrow(/simulated write failure/);

    expect(created.length).toBeGreaterThan(0);
    for (const dir of created) {
      await expect(fs.stat(dir)).rejects.toThrow();
    }
  });
});

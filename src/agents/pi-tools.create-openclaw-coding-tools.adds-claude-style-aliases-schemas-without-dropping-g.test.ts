import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool, createSandboxedReadTool } from "./pi-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find((block) => {
    return (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    );
  }) as { text?: string } | undefined;
  return textBlock?.text ?? "";
}

describe("createOpenClawCodingTools read behavior", () => {
  it("applies sandbox path guards to canonical path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "openclaw-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      await expect(readTool.execute("sandbox-1", { path: outsidePath })).rejects.toThrow(
        /sandbox root/i,
      );
    } finally {
      await fs.rm(outsidePath, { force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-pages read output across chunks when context window budget allows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-autopage-"));
    const filePath = path.join(tmpDir, "big.txt");
    const lines = Array.from(
      { length: 5000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 200_000,
      });
      const result = await readTool.execute("read-autopage-1", { path: "big.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("line-5000");
      expect(text).not.toContain("Read output capped at");
      expect(text).not.toMatch(/Use offset=\d+ to continue\.\]$/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds capped continuation guidance when aggregated read output reaches budget", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-cap-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const lines = Array.from(
      { length: 8000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-cap-1", { path: "huge.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("[Read output capped at 32KB for this call. Use offset=");
      expect(text).not.toContain("line-8000");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty content for explicit offsets beyond EOF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-eof-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-offset-limit", {
        path: "notes.txt",
        offset: 99,
        limit: 10,
      });

      expect(extractToolText(result)).toBe("");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty content for adaptive offsets beyond EOF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-offset-adaptive-"));
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "one\ntwo\nthree\n", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        root: tmpDir,
        bridge: createHostSandboxFsBridge(tmpDir),
      });
      const result = await readTool.execute("read-offset-adaptive", {
        path: "notes.txt",
        offset: 99,
      });

      expect(extractToolText(result)).toBe("");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns already-read adaptive content when pagination reaches EOF", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [
        {
          type: "text",
          text: "one\n\n[1 more lines in file. Use offset=2 to continue.]",
        },
      ],
      details: {
        truncation: {
          truncated: true,
          outputLines: 1,
          firstLineExceedsLimit: false,
        },
      },
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce(readResult)
      .mockRejectedValueOnce(new Error("Offset 2 is beyond end of file (1 lines total)"));
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute,
    });

    const result = await readTool.execute("read-offset-paging-eof", {
      path: "notes.txt",
      offset: 1,
    });

    expect(extractToolText(result)).toBe("one");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps unrelated read failures loud", async () => {
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });

    await expect(
      readTool.execute("read-unrelated-error", {
        path: "notes.txt",
        offset: 99,
      }),
    ).rejects.toThrow("read failed");
  });

  it("strips truncation.content details from read results while preserving other fields", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [{ type: "text" as const, text: "line-0001" }],
      details: {
        truncation: {
          truncated: true,
          outputLines: 1,
          firstLineExceedsLimit: false,
          content: "hidden duplicate payload",
        },
      },
    };
    const baseRead: AgentTool = {
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: vi.fn(async () => readResult),
    };

    const wrapped = createOpenClawReadTool(
      baseRead as unknown as Parameters<typeof createOpenClawReadTool>[0],
    );
    const result = await wrapped.execute("read-strip-1", { path: "demo.txt", limit: 1 });

    const details = (result as { details?: { truncation?: Record<string, unknown> } }).details;
    expect(details?.truncation?.truncated).toBe(true);
    expect(details?.truncation?.outputLines).toBe(1);
    expect(details?.truncation?.firstLineExceedsLimit).toBe(false);
    expect(details?.truncation).not.toHaveProperty("content");
  });
});

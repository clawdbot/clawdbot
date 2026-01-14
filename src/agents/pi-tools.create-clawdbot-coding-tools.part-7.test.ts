import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { __testing, createClawdbotCodingTools } from "./pi-tools.js";

describe("createClawdbotCodingTools", () => {
  describe("Claude/Gemini alias support", () => {
    it("adds Claude-style aliases to schemas without dropping metadata", () => {
      const base: AgentTool = {
        name: "write",
        description: "test",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Path" },
            content: { type: "string", description: "Body" },
          },
        },
        execute: vi.fn(),
      };

      const patched = __testing.patchToolSchemaForClaudeCompatibility(base);
      const params = patched.parameters as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const props = params.properties ?? {};

      expect(props.file_path).toEqual(props.path);
      expect(params.required ?? []).not.toContain("path");
      expect(params.required ?? []).not.toContain("file_path");
    });

    it("normalizes file_path to path and enforces required groups at runtime", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool: AgentTool = {
        name: "write",
        description: "test",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        execute,
      };

      const wrapped = __testing.wrapToolParamNormalization(tool, [
        { keys: ["path", "file_path"] },
      ]);

      await wrapped.execute("tool-1", { file_path: "foo.txt", content: "x" });
      expect(execute).toHaveBeenCalledWith(
        "tool-1",
        { path: "foo.txt", content: "x" },
        undefined,
        undefined,
      );

      await expect(wrapped.execute("tool-2", { content: "x" })).rejects.toThrow(
        /Missing required parameter/,
      );
      await expect(
        wrapped.execute("tool-3", { file_path: "   ", content: "x" }),
      ).rejects.toThrow(/Missing required parameter/);
    });
  });

  it("applies sandbox path guards to file_path alias", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "clawdbot-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const sandbox = {
        enabled: true,
        sessionKey: "sandbox:test",
        workspaceDir: tmpDir,
        agentWorkspaceDir: path.join(os.tmpdir(), "clawdbot-workspace"),
        workspaceAccess: "ro",
        containerName: "clawdbot-sbx-test",
        containerWorkdir: "/workspace",
        docker: {
          image: "clawdbot-sandbox:bookworm-slim",
          containerPrefix: "clawdbot-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
        },
        tools: {
          allow: ["read"],
          deny: [],
        },
        browserAllowHostControl: false,
      };

      const tools = createClawdbotCodingTools({ sandbox });
      const readTool = tools.find((tool) => tool.name === "read");
      expect(readTool).toBeDefined();

      await expect(
        readTool?.execute("tool-sbx-1", { file_path: outsidePath }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsidePath, { force: true });
    }
  });
  it("falls back to process.cwd() when workspaceDir not provided", () => {
    const prevCwd = process.cwd();
    const tools = createClawdbotCodingTools();
    // Tools should be created without error
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(true);
    expect(tools.some((tool) => tool.name === "edit")).toBe(true);
    // cwd should be unchanged
    expect(process.cwd()).toBe(prevCwd);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createMoltbotCodingTools } from "./pi-tools.js";

describe("createMoltbotCodingTools", () => {
  it("uses workspaceDir for Read tool path resolution", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-ws-"));
    try {
      // Create a test file in the "workspace"
      const testFile = "test-workspace-file.txt";
      const testContent = "workspace path resolution test";
      await fs.writeFile(path.join(tmpDir, testFile), testContent, "utf8");

      // Create tools with explicit workspaceDir
      const tools = createMoltbotCodingTools({ workspaceDir: tmpDir });
      const readTool = tools.find((tool) => tool.name === "read");
      expect(readTool).toBeDefined();

      // Read using relative path - should resolve against workspaceDir
      const result = await readTool?.execute("tool-ws-1", {
        path: testFile,
      });

      const textBlocks = result?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain(testContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("uses workspaceDir for Write tool path resolution", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-ws-"));
    try {
      const testFile = "test-write-file.txt";
      const testContent = "written via workspace path";

      // Create tools with explicit workspaceDir
      const tools = createMoltbotCodingTools({ workspaceDir: tmpDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      // Write using relative path - should resolve against workspaceDir
      await writeTool?.execute("tool-ws-2", {
        path: testFile,
        content: testContent,
      });

      // Verify file was written to workspaceDir
      const written = await fs.readFile(path.join(tmpDir, testFile), "utf8");
      expect(written).toBe(testContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("uses workspaceDir for Edit tool path resolution", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-ws-"));
    try {
      const testFile = "test-edit-file.txt";
      const originalContent = "hello world";
      const expectedContent = "hello universe";
      await fs.writeFile(path.join(tmpDir, testFile), originalContent, "utf8");

      // Create tools with explicit workspaceDir
      const tools = createMoltbotCodingTools({ workspaceDir: tmpDir });
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(editTool).toBeDefined();

      // Edit using relative path - should resolve against workspaceDir
      await editTool?.execute("tool-ws-3", {
        path: testFile,
        oldText: "world",
        newText: "universe",
      });

      // Verify file was edited in workspaceDir
      const edited = await fs.readFile(path.join(tmpDir, testFile), "utf8");
      expect(edited).toBe(expectedContent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("accepts Claude Code parameter aliases for read/write/edit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-alias-"));
    try {
      const tools = createMoltbotCodingTools({ workspaceDir: tmpDir });
      const readTool = tools.find((tool) => tool.name === "read");
      const writeTool = tools.find((tool) => tool.name === "write");
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(readTool).toBeDefined();
      expect(writeTool).toBeDefined();
      expect(editTool).toBeDefined();

      const filePath = "alias-test.txt";
      await writeTool?.execute("tool-alias-1", {
        file_path: filePath,
        content: "hello world",
      });

      await editTool?.execute("tool-alias-2", {
        file_path: filePath,
        old_string: "world",
        new_string: "universe",
      });

      const result = await readTool?.execute("tool-alias-3", {
        file_path: filePath,
      });

      const textBlocks = result?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain("hello universe");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

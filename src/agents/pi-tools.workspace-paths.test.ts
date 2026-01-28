import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createMoltbotCodingTools } from "./pi-tools.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function getTextContent(result?: { content?: Array<{ type: string; text?: string }> }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

describe("workspace path resolution", () => {
  it("reads relative paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("moltbot-ws-", async (workspaceDir) => {
      await withTempDir("moltbot-cwd-", async (otherDir) => {
        const prevCwd = process.cwd();
        const testFile = "read.txt";
        const contents = "workspace read ok";
        await fs.writeFile(path.join(workspaceDir, testFile), contents, "utf8");

        process.chdir(otherDir);
        try {
          const tools = createMoltbotCodingTools({ workspaceDir });
          const readTool = tools.find((tool) => tool.name === "read");
          expect(readTool).toBeDefined();

          const result = await readTool?.execute("ws-read", { path: testFile });
          expect(getTextContent(result)).toContain(contents);
        } finally {
          process.chdir(prevCwd);
        }
      });
    });
  });

  it("writes relative paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("moltbot-ws-", async (workspaceDir) => {
      await withTempDir("moltbot-cwd-", async (otherDir) => {
        const prevCwd = process.cwd();
        const testFile = "write.txt";
        const contents = "workspace write ok";

        process.chdir(otherDir);
        try {
          const tools = createMoltbotCodingTools({ workspaceDir });
          const writeTool = tools.find((tool) => tool.name === "write");
          expect(writeTool).toBeDefined();

          await writeTool?.execute("ws-write", {
            path: testFile,
            content: contents,
          });

          const written = await fs.readFile(path.join(workspaceDir, testFile), "utf8");
          expect(written).toBe(contents);
        } finally {
          process.chdir(prevCwd);
        }
      });
    });
  });

  it("edits relative paths against workspaceDir even after cwd changes", async () => {
    await withTempDir("moltbot-ws-", async (workspaceDir) => {
      await withTempDir("moltbot-cwd-", async (otherDir) => {
        const prevCwd = process.cwd();
        const testFile = "edit.txt";
        await fs.writeFile(path.join(workspaceDir, testFile), "hello world", "utf8");

        process.chdir(otherDir);
        try {
          const tools = createMoltbotCodingTools({ workspaceDir });
          const editTool = tools.find((tool) => tool.name === "edit");
          expect(editTool).toBeDefined();

          await editTool?.execute("ws-edit", {
            path: testFile,
            oldText: "world",
            newText: "moltbot",
          });

          const updated = await fs.readFile(path.join(workspaceDir, testFile), "utf8");
          expect(updated).toBe("hello moltbot");
        } finally {
          process.chdir(prevCwd);
        }
      });
    });
  });

  it("defaults exec cwd to workspaceDir when workdir is omitted", async () => {
    await withTempDir("moltbot-ws-", async (workspaceDir) => {
      const tools = createMoltbotCodingTools({ workspaceDir });
      const execTool = tools.find((tool) => tool.name === "exec");
      expect(execTool).toBeDefined();

      const result = await execTool?.execute("ws-exec", {
        command: "echo ok",
      });
      const cwd =
        result?.details && typeof result.details === "object" && "cwd" in result.details
          ? (result.details as { cwd?: string }).cwd
          : undefined;
      expect(cwd).toBeTruthy();
      const [resolvedOutput, resolvedWorkspace] = await Promise.all([
        fs.realpath(String(cwd)),
        fs.realpath(workspaceDir),
      ]);
      expect(resolvedOutput).toBe(resolvedWorkspace);
    });
  });

  it("lets exec workdir override the workspace default", async () => {
    await withTempDir("moltbot-ws-", async (workspaceDir) => {
      await withTempDir("moltbot-override-", async (overrideDir) => {
        const tools = createMoltbotCodingTools({ workspaceDir });
        const execTool = tools.find((tool) => tool.name === "exec");
        expect(execTool).toBeDefined();

        const result = await execTool?.execute("ws-exec-override", {
          command: "echo ok",
          workdir: overrideDir,
        });
        const cwd =
          result?.details && typeof result.details === "object" && "cwd" in result.details
            ? (result.details as { cwd?: string }).cwd
            : undefined;
        expect(cwd).toBeTruthy();
        const [resolvedOutput, resolvedOverride] = await Promise.all([
          fs.realpath(String(cwd)),
          fs.realpath(overrideDir),
        ]);
        expect(resolvedOutput).toBe(resolvedOverride);
      });
    });
  });
});

describe("sandboxed workspace paths", () => {
  it("uses sandbox workspace for relative read/write/edit", async () => {
    await withTempDir("moltbot-sandbox-", async (sandboxDir) => {
      await withTempDir("moltbot-workspace-", async (workspaceDir) => {
        const sandbox = {
          enabled: true,
          sessionKey: "sandbox:test",
          workspaceDir: sandboxDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          containerName: "moltbot-sbx-test",
          containerWorkdir: "/workspace",
          docker: {
            image: "moltbot-sandbox:bookworm-slim",
            containerPrefix: "moltbot-sbx-",
            workdir: "/workspace",
            readOnlyRoot: true,
            tmpfs: [],
            network: "none",
            user: "1000:1000",
            capDrop: ["ALL"],
            env: { LANG: "C.UTF-8" },
          },
          tools: { allow: [], deny: [] },
          browserAllowHostControl: false,
        };

        const testFile = "sandbox.txt";
        await fs.writeFile(path.join(sandboxDir, testFile), "sandbox read", "utf8");
        await fs.writeFile(path.join(workspaceDir, testFile), "workspace read", "utf8");

        const tools = createMoltbotCodingTools({ workspaceDir, sandbox });
        const readTool = tools.find((tool) => tool.name === "read");
        const writeTool = tools.find((tool) => tool.name === "write");
        const editTool = tools.find((tool) => tool.name === "edit");

        expect(readTool).toBeDefined();
        expect(writeTool).toBeDefined();
        expect(editTool).toBeDefined();

        const result = await readTool?.execute("sbx-read", { path: testFile });
        expect(getTextContent(result)).toContain("sandbox read");

        await writeTool?.execute("sbx-write", {
          path: "new.txt",
          content: "sandbox write",
        });
        const written = await fs.readFile(path.join(sandboxDir, "new.txt"), "utf8");
        expect(written).toBe("sandbox write");

        await editTool?.execute("sbx-edit", {
          path: "new.txt",
          oldText: "write",
          newText: "edit",
        });
        const edited = await fs.readFile(path.join(sandboxDir, "new.txt"), "utf8");
        expect(edited).toBe("sandbox edit");
      });
    });
  });
});

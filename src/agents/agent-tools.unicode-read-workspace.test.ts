import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { expectReadWriteEditTools, getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("workspace-only Unicode read fallback", () => {
  it("does not follow a filename fallback into a sibling workspace", async (context) => {
    await withTempDir("openclaw-unicode-parent-", async (rootDir) => {
      const workspaceDir = path.join(rootDir, "cafe\u0301");
      const outsideDir = path.join(rootDir, "caf\u00e9");
      await fs.mkdir(workspaceDir);
      try {
        await fs.mkdir(outsideDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          context.skip();
          return;
        }
        throw error;
      }
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside secret", "utf8");

      const config: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      const tools = createOpenClawCodingTools({ workspaceDir, config });
      const { readTool } = expectReadWriteEditTools(tools);

      await expect(
        readTool.execute("ws-read-unicode-parent", { path: "secret.txt" }),
      ).rejects.toThrow(/File not found/i);
    });
  });

  it("keeps filename fallback working inside the guarded workspace", async () => {
    await withTempDir("openclaw-unicode-leaf-", async (workspaceDir) => {
      await fs.writeFile(path.join(workspaceDir, "d\u2019accord.txt"), "allowed fallback", "utf8");

      const config: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      const tools = createOpenClawCodingTools({ workspaceDir, config });
      const { readTool } = expectReadWriteEditTools(tools);

      const result = await readTool.execute("ws-read-unicode-leaf", { path: "d'accord.txt" });
      expect(getTextContent(result)).toContain("allowed fallback");
    });
  });
});

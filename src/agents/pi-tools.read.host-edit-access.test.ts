import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostWorkspaceEditTool } from "./pi-tools.read.js";

type CapturedEditOperations = {
  access: (absolutePath: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  operations: undefined as CapturedEditOperations | undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.operations = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      };
    },
  };
});

describe("createHostWorkspaceEditTool host access mapping", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.operations = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it.runIf(process.platform !== "win32")(
    "silently passes access for outside-workspace paths so readFile reports the real error",
    async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-access-test-"));
      const workspaceDir = path.join(tmpDir, "workspace");
      const outsideDir = path.join(tmpDir, "outside");
      const linkDir = path.join(workspaceDir, "escape");
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "secret", "utf8");
      await fs.symlink(outsideDir, linkDir);

      createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });
      if (mocks.operations === undefined) {
        throw new Error("expected host edit operations mock");
      }

      // access must NOT throw for outside-workspace paths; the upstream
      // library replaces any access error with a misleading "File not found".
      // By resolving silently the subsequent readFile call surfaces the real
      // "Path escapes workspace root" / "outside-workspace" error instead.
      const operations = mocks.operations;
      expect(operations).toBeDefined();
      if (!operations) {
        throw new Error("Expected workspace edit operations to be registered.");
      }
      await expect(
        operations.access(path.join(workspaceDir, "escape", "secret.txt")),
      ).resolves.toBeUndefined();
    },
  );
});

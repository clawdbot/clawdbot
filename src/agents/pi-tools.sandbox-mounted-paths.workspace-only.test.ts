import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./pi-tools.read.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./sandbox/constants.js";
import {
  expectReadWriteEditTools,
  expectReadWriteTools,
  getTextContent,
} from "./test-helpers/pi-tools-fs-helpers.js";
import { withUnsafeMountedSandboxHarness } from "./test-helpers/unsafe-mounted-sandbox.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

type ToolWithExecute = {
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};
type UnsafeMountedSandboxHarness = Parameters<typeof withUnsafeMountedSandboxHarness>[0] extends (
  harness: infer THarness,
) => unknown
  ? THarness
  : never;
type UnsafeMountedSandbox = UnsafeMountedSandboxHarness["sandbox"];

const APPLY_PATCH_PAYLOAD = `*** Begin Patch
*** Add File: /agent/pwned.txt
+owned-by-apply-patch
*** End Patch`;

function resolveApplyPatchTool(params: {
  sandbox: UnsafeMountedSandbox;
  config: OpenClawConfig;
}): ToolWithExecute {
  return createApplyPatchTool({
    cwd: params.sandbox.workspaceDir,
    sandbox: { root: params.sandbox.workspaceDir, bridge: params.sandbox.fsBridge! },
    workspaceOnly: params.config.tools?.exec?.applyPatch?.workspaceOnly !== false,
  }) as ToolWithExecute;
}

function createSandboxFsTools(params: { sandbox: UnsafeMountedSandbox; workspaceOnly?: boolean }) {
  const tools = [
    createSandboxedReadTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
    createSandboxedWriteTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
    createSandboxedEditTool({
      root: params.sandbox.workspaceDir,
      bridge: params.sandbox.fsBridge!,
    }),
  ];
  if (!params.workspaceOnly) {
    return tools;
  }
  return tools.map((tool) =>
    wrapToolWorkspaceRootGuardWithOptions(tool, params.sandbox.workspaceDir, {
      additionalContainerMounts:
        tool.name === "read" && params.sandbox.workspaceAccess === "ro"
          ? [
              {
                containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
                hostRoot: params.sandbox.agentWorkspaceDir,
              },
            ]
          : undefined,
      containerWorkdir: params.sandbox.containerWorkdir,
    }),
  );
}

describe("tools.fs.workspaceOnly", () => {
  it("defaults to allowing sandbox mounts outside the workspace root", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const tools = createSandboxFsTools({ sandbox });
      const { readTool, writeTool } = expectReadWriteTools(tools);

      const readResult = await readTool?.execute("t1", { path: "/agent/secret.txt" });
      expect(getTextContent(readResult)).toContain("shh");

      await writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" });
      expect(await fs.readFile(path.join(agentRoot, "owned.txt"), "utf8")).toBe("x");
    });
  });

  it("rejects sandbox mounts outside the workspace root when enabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

      const tools = createSandboxFsTools({ sandbox, workspaceOnly: true });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      await expect(readTool?.execute("t1", { path: "/agent/secret.txt" })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );

      await expect(
        writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      const missingOwnedFile = await fs
        .stat(path.join(agentRoot, "owned.txt"))
        .catch((error: unknown) => error);
      expect((missingOwnedFile as NodeJS.ErrnoException).code).toBe("ENOENT");

      await expect(
        editTool?.execute("t3", { path: "/agent/secret.txt", oldText: "shh", newText: "nope" }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(await fs.readFile(path.join(agentRoot, "secret.txt"), "utf8")).toBe("shh");
    });
  });

  it("allows read-only agent workspace mounts for sandbox reads only", async () => {
    await withUnsafeMountedSandboxHarness(
      async ({ agentRoot, sandbox }) => {
        await fs.writeFile(path.join(agentRoot, "secret.txt"), "shh", "utf8");

        const tools = createSandboxFsTools({ sandbox, workspaceOnly: true });
        const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

        const readResult = await readTool?.execute("t1", { path: "/agent/secret.txt" });
        expect(getTextContent(readResult)).toContain("shh");

        await expect(
          writeTool?.execute("t2", { path: "/agent/owned.txt", content: "x" }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        const missingOwnedFile = await fs
          .stat(path.join(agentRoot, "owned.txt"))
          .catch((error: unknown) => error);
        expect((missingOwnedFile as NodeJS.ErrnoException).code).toBe("ENOENT");

        await expect(
          editTool?.execute("t3", { path: "/agent/secret.txt", oldText: "shh", newText: "nope" }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
        expect(await fs.readFile(path.join(agentRoot, "secret.txt"), "utf8")).toBe("shh");
      },
      { workspaceAccess: "ro" },
    );
  });

  it("enforces apply_patch workspace-only in sandbox mounts by default", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      const applyPatchTool = resolveApplyPatchTool({
        sandbox,
        config: {
          tools: {
            allow: ["read", "write", "exec"],
            exec: { applyPatch: {} },
          },
        } as OpenClawConfig,
      });

      await expect(applyPatchTool.execute("t1", { input: APPLY_PATCH_PAYLOAD })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      const missingPatchedFile = await fs
        .stat(path.join(agentRoot, "pwned.txt"))
        .catch((error: unknown) => error);
      expect((missingPatchedFile as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  it("allows apply_patch outside workspace root when explicitly disabled", async () => {
    await withUnsafeMountedSandboxHarness(async ({ agentRoot, sandbox }) => {
      const applyPatchTool = resolveApplyPatchTool({
        sandbox,
        config: {
          tools: {
            allow: ["read", "write", "exec"],
            exec: { applyPatch: { workspaceOnly: false } },
          },
        } as OpenClawConfig,
      });

      await applyPatchTool.execute("t2", { input: APPLY_PATCH_PAYLOAD });
      expect(await fs.readFile(path.join(agentRoot, "pwned.txt"), "utf8")).toBe(
        "owned-by-apply-patch\n",
      );
    });
  });
});

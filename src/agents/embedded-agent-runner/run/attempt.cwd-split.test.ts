// Coverage for keeping attempt workspace and runtime cwd distinct.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

function stubTool(name: string) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  } satisfies AnyAgentTool;
}

function readCustomToolNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !("customTools" in value)) {
    throw new Error("Expected embedded session options with customTools");
  }
  const customTools = value.customTools;
  if (!Array.isArray(customTools)) {
    throw new Error("Expected customTools to be an array");
  }
  return customTools.map((tool) => {
    if (typeof tool !== "object" || tool === null || !("name" in tool)) {
      throw new Error("Expected every custom tool to have a name");
    }
    if (typeof tool.name !== "string") {
      throw new Error("Expected every custom tool name to be a string");
    }
    return tool.name;
  });
}

describe("runEmbeddedAttempt cwd/workspace split", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("uses workspace for bootstrap and cwd for runtime tools", async () => {
    // Bootstrap still reads the agent workspace, while coding tools execute in
    // the task repo cwd when a subagent targets a separate checkout.
    const bootstrap = createContextEngineBootstrapAndAssemble();
    const taskRepo = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-repo-"));
    tempPaths.push(taskRepo);
    hoisted.createOpenClawCodingToolsMock.mockImplementationOnce(() =>
      [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "message",
        "browser",
        "web_search",
      ].map(stubTool),
    );

    await createContextEngineAttemptRunner({
      contextEngine: bootstrap,
      sessionKey: "agent:main:subagent:child",
      tempPaths,
      attemptOverrides: {
        cwd: taskRepo,
        requireWorkspaceOnly: true,
        toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process"],
        disableTools: false,
      },
    });

    const bootstrapCall = hoisted.resolveBootstrapFilesForRunMock.mock.calls[0]?.[0] as
      | { agentId?: string; workspaceDir?: string }
      | undefined;
    expect(bootstrapCall?.workspaceDir).not.toBe("/tmp/task-repo");
    expect(bootstrapCall?.agentId).toBe("main");

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0] as
      | {
          cwd?: string;
          workspaceDir?: string;
          spawnWorkspaceDir?: string;
          requireWorkspaceOnly?: boolean;
        }
      | undefined;
    expect(toolsCall?.cwd).toBe(taskRepo);
    expect(toolsCall).toMatchObject({
      runtimeToolAllowlist: ["read", "write", "edit", "apply_patch", "exec", "process"],
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    expect(toolsCall).not.toMatchObject({
      runtimeToolAllowlist: expect.arrayContaining(["message", "browser", "web_search"]),
    });
    expect(readCustomToolNames(hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0])).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
    ]);
    expect(toolsCall?.workspaceDir).toBe(bootstrapCall?.workspaceDir);
    expect(toolsCall?.spawnWorkspaceDir).toBe(bootstrapCall?.workspaceDir);
    expect(toolsCall?.requireWorkspaceOnly).toBe(true);

    const resourceLoaderInit = hoisted.defaultResourceLoaderInitMock.mock.calls[0]?.[0] as
      | { cwd?: string }
      | undefined;
    expect(resourceLoaderInit?.cwd).toBe(taskRepo);
    expect(hoisted.embeddedSystemPromptInputs[0]).toMatchObject({
      workspaceDir: bootstrapCall?.workspaceDir,
      runtimeCwd: taskRepo,
    });
  });

  it.each([
    ["read-only", "deny"],
    ["guarded", "ask"],
    ["workspace", "auto"],
    ["full", "full"],
  ] as const)("maps session permission mode %s to native exec mode %s", async (mode, execMode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-permission-mode-"));
    tempPaths.push(root);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:dashboard:permission-mode",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        permissionMode: mode,
        sessionRoot: root,
        workspaceDir: root,
      },
    });

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
      | {
          exec?: { mode?: string };
          sessionPermissionPolicy?: { root: string; mode: string };
        }
      | undefined;
    expect(toolsCall?.sessionPermissionPolicy).toEqual({ root, mode });
    expect(toolsCall?.exec?.mode).toBe(execMode);
  });

  it("defaults rootless session permission boundaries to the canonical agent workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rootless-permission-"));
    tempPaths.push(workspaceDir);
    const canonicalWorkspace = await fs.realpath(workspaceDir);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:discord:direct:rootless-permission",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        permissionMode: "workspace",
        workspaceDir,
      },
    });

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
      | { sessionPermissionPolicy?: { root: string; mode: string } }
      | undefined;
    expect(toolsCall?.sessionPermissionPolicy).toEqual({
      root: canonicalWorkspace,
      mode: "workspace",
    });
  });

  it("forwards native and routable channel targets into runtime tools", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:slack:direct:U123",
      tempPaths,
      attemptOverrides: {
        chatId: "oc_native_chat",
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        disableTools: false,
      },
    });

    const toolsCall = hoisted.createOpenClawCodingToolsMock.mock.calls[0]?.[0] as
      | {
          currentChannelId?: string;
          currentMessagingTarget?: string;
          nativeChannelId?: string;
        }
      | undefined;
    expect(toolsCall).toMatchObject({
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      nativeChannelId: "oc_native_chat",
    });
  });

  it("skips runtime tool construction when the selected model does not support tools", async () => {
    hoisted.supportsModelToolsMock.mockReturnValueOnce(false);

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
      },
    });

    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("rejects cwd overrides for sandboxed runs instead of silently ignoring them", async () => {
    // Sandboxed attempts already remap the workspace; accepting an extra cwd
    // override would make tool roots ambiguous.
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: "/tmp/openclaw-sandbox-copy",
    });

    await expect(
      createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:subagent:child",
        tempPaths,
        attemptOverrides: {
          cwd: "/tmp/task-repo",
        },
      }),
    ).rejects.toThrow("cwd override is not supported");
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("runs a managed worktree when sandbox workspace and cwd match", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-worktree-"));
    tempPaths.push(worktree);
    hoisted.resolveSandboxContextMock.mockResolvedValueOnce({
      enabled: true,
      workspaceAccess: "rw",
      workspaceDir: worktree,
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:dashboard:worktree",
      tempPaths,
      attemptOverrides: {
        workspaceDir: worktree,
        cwd: worktree,
        disableTools: false,
      },
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: worktree, workspaceDir: worktree }),
    );
  });
});

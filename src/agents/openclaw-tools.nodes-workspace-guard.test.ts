// Verifies nodes outPath normalization and workspace-only sandbox enforcement.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn(async (params: { filePath: string; cwd: string; root: string }) => {
    // Lightweight path resolver mirrors the sandbox escape check without touching disk.
    const root = `/${params.root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`;
    const candidate = params.filePath.replace(/\\/g, "/");
    const input = candidate.startsWith("/") ? candidate : `${root}/${candidate}`;
    const segments = input.split("/");
    const stack: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === ".") {
        continue;
      }
      if (segment === "..") {
        stack.pop();
        continue;
      }
      stack.push(segment);
    }
    const resolved = `/${stack.join("/")}`;
    const inside = resolved === root || resolved.startsWith(`${root}/`);
    if (!inside) {
      throw new Error(`Path escapes sandbox root (${root}): ${params.filePath}`);
    }
    const relative = resolved === root ? "" : resolved.slice(root.length + 1);
    return { resolved, relative };
  }),
}));

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: mocks.assertSandboxPath,
}));

const WORKSPACE_ROOT = "/tmp/openclaw-workspace-nodes-guard";

function createNodesToolHarness() {
  // Guard wraps a minimal nodes tool so tests assert only argument rewriting.
  const nodesExecute = vi.fn(async () => ({
    content: [{ type: "text", text: "ok" }],
    details: {},
  }));
  const tool = {
    description: "nodes test tool",
    execute: nodesExecute,
    label: "Nodes",
    name: "nodes",
    parameters: {
      properties: {},
      type: "object",
    },
  } as unknown as AnyAgentTool;
  return { nodesExecute, tool };
}

describe("applyNodesToolWorkspaceGuard", () => {
  beforeEach(() => {
    mocks.assertSandboxPath.mockClear();
  });

  function getNodesTool(
    workspaceOnly: boolean,
    options?: { sandboxRoot?: string; sandboxContainerWorkdir?: string },
  ): ReturnType<typeof createNodesToolHarness> & { guardedTool: AnyAgentTool } {
    const harness = createNodesToolHarness();
    return {
      ...harness,
      guardedTool: applyNodesToolWorkspaceGuard(harness.tool, {
        workspaceDir: WORKSPACE_ROOT,
        fsPolicy: { workspaceOnly },
        sandboxRoot: options?.sandboxRoot,
        sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
      }),
    };
  }

  it("guards outPath when workspaceOnly is enabled", async () => {
    const { guardedTool, nodesExecute } = getNodesTool(true);
    await guardedTool.execute("call-1", {
      action: "screen_record",
      outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      cwd: WORKSPACE_ROOT,
      root: WORKSPACE_ROOT,
    });
    expect(nodesExecute).toHaveBeenCalledTimes(1);
  });

  it("normalizes relative outPath to an absolute workspace path before execute", async () => {
    const { guardedTool, nodesExecute } = getNodesTool(true);
    await guardedTool.execute("call-rel", {
      action: "screen_record",
      outPath: "videos/capture.mp4",
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: "videos/capture.mp4",
      cwd: WORKSPACE_ROOT,
      root: WORKSPACE_ROOT,
    });
    expect(nodesExecute).toHaveBeenCalledWith(
      "call-rel",
      {
        action: "screen_record",
        outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      },
      undefined,
      undefined,
    );
  });

  it("maps sandbox container outPath to host root when containerWorkdir is provided", async () => {
    const { guardedTool, nodesExecute } = getNodesTool(true, {
      sandboxRoot: WORKSPACE_ROOT,
      sandboxContainerWorkdir: "/workspace",
    });
    await guardedTool.execute("call-sandbox", {
      action: "screen_record",
      outPath: "/workspace/videos/capture.mp4",
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      filePath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      cwd: WORKSPACE_ROOT,
      root: WORKSPACE_ROOT,
    });
    expect(nodesExecute).toHaveBeenCalledWith(
      "call-sandbox",
      {
        action: "screen_record",
        outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      },
      undefined,
      undefined,
    );
  });

  it("rejects outPath outside workspace when workspaceOnly is enabled", async () => {
    const { guardedTool, nodesExecute } = getNodesTool(true);
    await expect(
      guardedTool.execute("call-2", {
        action: "screen_record",
        outPath: "/etc/passwd",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/);

    expect(mocks.assertSandboxPath).toHaveBeenCalledTimes(1);
    expect(nodesExecute).not.toHaveBeenCalled();
  });

  it("does not guard outPath when workspaceOnly is disabled", async () => {
    const { guardedTool, nodesExecute } = getNodesTool(false);
    await guardedTool.execute("call-3", {
      action: "screen_record",
      outPath: "/etc/passwd",
    });

    expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
    expect(nodesExecute).toHaveBeenCalledTimes(1);
  });
});

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvasTool } from "./tool.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  imageResultFromFile: vi.fn(async (params) => ({ content: [], details: params })),
  listNodes: vi.fn(async () => []),
  resolveNodeIdFromList: vi.fn(() => "node-1"),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: mocks.callGatewayTool,
  listNodes: mocks.listNodes,
  resolveNodeIdFromList: mocks.resolveNodeIdFromList,
}));

vi.mock("openclaw/plugin-sdk/channel-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-actions")>()),
  imageResultFromFile: mocks.imageResultFromFile,
}));

describe("Canvas tool", () => {
  let tempRoot: string | undefined;

  beforeEach(() => {
    mocks.callGatewayTool.mockReset();
    mocks.imageResultFromFile.mockClear();
    mocks.listNodes.mockClear();
    mocks.listNodes.mockResolvedValue([]);
    mocks.resolveNodeIdFromList.mockClear();
    mocks.resolveNodeIdFromList.mockReturnValue("node-1");
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects jsonlPath symlinks that resolve outside the workspace",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-tool-"));
      const workspaceDir = path.join(tempRoot, "workspace");
      await mkdir(workspaceDir);
      const outsidePath = path.join(tempRoot, "outside.jsonl");
      await writeFile(outsidePath, '{"secret":true}\n');
      await symlink(outsidePath, path.join(workspaceDir, "events.jsonl"));

      const tool = createCanvasTool({ workspaceDir });

      await expect(
        tool.execute("tool-call-1", {
          action: "a2ui_push",
          jsonlPath: "events.jsonl",
        }),
      ).rejects.toThrow("jsonlPath outside workspace");
      expect(mocks.callGatewayTool).not.toHaveBeenCalled();
    },
  );

  it("applies configured image limits to canvas snapshots", async () => {
    mocks.callGatewayTool.mockResolvedValue({
      payload: {
        format: "png",
        base64: Buffer.from("not-a-real-png").toString("base64"),
      },
    });
    const tool = createCanvasTool({
      config: {
        agents: {
          defaults: {
            imageMaxDimensionPx: 1600.9,
          },
        },
      },
    });

    await tool.execute("tool-call-1", { action: "snapshot" });

    expect(mocks.imageResultFromFile).toHaveBeenCalledTimes(1);
    const imageResultParams = mocks.imageResultFromFile.mock.calls[0]?.[0] as
      | {
          label?: string;
          path?: string;
          details?: unknown;
          imageSanitization?: unknown;
        }
      | undefined;
    expect(imageResultParams?.label).toBe("canvas:snapshot");
    expect(imageResultParams?.path).toMatch(/openclaw-canvas-snapshot-.*\.png$/);
    expect(imageResultParams?.details).toEqual({ format: "png" });
    expect(imageResultParams?.imageSanitization).toEqual({ maxDimensionPx: 1600 });
  });
});

// Canvas tests cover tool plugin behavior.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvasTool } from "./tool.js";

const VALID_A2UI_V08_JSONL = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [
        {
          id: "root",
          component: { Text: { text: { literalString: "Canvas proof" }, usageHint: "body" } },
        },
      ],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");

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
      expect(mocks.listNodes).not.toHaveBeenCalled();
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

  it("normalizes numeric string params before invoking node canvas commands", async () => {
    mocks.callGatewayTool.mockResolvedValue({
      payload: {
        format: "png",
        base64: Buffer.from("not-a-real-png").toString("base64"),
      },
    });
    const tool = createCanvasTool();

    await tool.execute("tool-call-1", {
      action: "present",
      timeoutMs: "1500",
      x: "10.5",
      y: "-2",
      width: "640",
      height: "480",
    });

    expect(mocks.callGatewayTool).toHaveBeenLastCalledWith(
      "node.invoke",
      { timeoutMs: 1500 },
      expect.objectContaining({
        command: "canvas.present",
        params: {
          placement: {
            x: 10.5,
            y: -2,
            width: 640,
            height: 480,
          },
        },
      }),
    );

    await tool.execute("tool-call-2", {
      action: "snapshot",
      maxWidth: "800",
      quality: "0.75",
    });

    expect(mocks.callGatewayTool).toHaveBeenLastCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        command: "canvas.snapshot",
        params: {
          format: "png",
          maxWidth: 800,
          quality: 0.75,
        },
      }),
    );
  });

  it("preserves an empty canvas eval result", async () => {
    mocks.callGatewayTool.mockResolvedValue({ payload: { result: "" } });
    const tool = createCanvasTool();

    const result = await tool.execute("tool-call-1", {
      action: "eval",
      javaScript: `""`,
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "" }],
      details: { result: "" },
    });
  });

  it("dispatches valid A2UI v0.8 JSONL unchanged", async () => {
    const tool = createCanvasTool({ agentSessionKey: "agent:main:canvas" });

    await tool.execute("tool-call-1", {
      action: "a2ui_push",
      jsonl: VALID_A2UI_V08_JSONL,
    });

    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      {
        nodeId: "node-1",
        command: "canvas.a2ui.pushJSONL",
        params: { jsonl: VALID_A2UI_V08_JSONL },
        idempotencyKey: expect.any(String),
        sessionKey: "agent:main:canvas",
      },
    );
  });

  it.each([
    ["malformed JSONL", "{not-json}", /Invalid A2UI JSONL/],
    [
      "A2UI v0.9 createSurface JSONL",
      JSON.stringify({
        version: "v0.9",
        createSurface: {
          surfaceId: "main",
          catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
        },
      }),
      /OpenClaw currently supports v0\.8 only/,
    ],
    [
      "legacy createSurface JSONL",
      JSON.stringify({ createSurface: { surfaceId: "main", root: "root" } }),
      /OpenClaw currently supports v0\.8 only/,
    ],
    [
      "A2UI v0.9 deleteSurface JSONL",
      JSON.stringify({ version: "v0.9", deleteSurface: { surfaceId: "main" } }),
      /OpenClaw currently supports v0\.8 only/,
    ],
    [
      "an unsupported explicit A2UI version",
      JSON.stringify({ version: "v1.0", deleteSurface: { surfaceId: "main" } }),
      /unsupported A2UI version: "v1\.0"/,
    ],
    [
      "an explicit version on an A2UI v0.8 message",
      JSON.stringify({ version: "v0.8", deleteSurface: { surfaceId: "main" } }),
      /A2UI v0\.8 messages must not include a version field/,
    ],
  ])("rejects %s before resolving or invoking a node", async (_label, jsonl, message) => {
    const tool = createCanvasTool();

    await expect(
      tool.execute("tool-call-1", {
        action: "a2ui_push",
        jsonl,
      }),
    ).rejects.toThrow(message);
    expect(mocks.listNodes).not.toHaveBeenCalled();
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects malformed numeric canvas params before invoking node commands", async () => {
    const tool = createCanvasTool();

    await expect(
      tool.execute("tool-call-1", {
        action: "snapshot",
        maxWidth: "800px",
      }),
    ).rejects.toThrow("maxWidth must be a positive integer");
    expect(mocks.listNodes).not.toHaveBeenCalled();
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects node-controlled snapshot formats before creating image results", async () => {
    mocks.callGatewayTool.mockResolvedValue({
      payload: {
        format: "/../../target.sh",
        base64: Buffer.from("not-a-real-png").toString("base64"),
      },
    });
    const tool = createCanvasTool();

    await expect(tool.execute("tool-call-1", { action: "snapshot" })).rejects.toThrow(
      /invalid canvas\.snapshot payload/i,
    );
    expect(mocks.imageResultFromFile).not.toHaveBeenCalled();
  });
});

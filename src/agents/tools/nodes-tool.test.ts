// Nodes tool tests cover gateway-scoped node actions, media payload writing,
// numeric schema guardrails, and pairing approval scopes.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
  resolveNode: vi.fn(async () => ({
    nodeId: "node-1",
    remoteIp: "127.0.0.1",
    platform: undefined as string | undefined,
  })),
}));

const nodesCameraMocks = vi.hoisted(() => ({
  cameraTempPath: vi.fn(({ facing }: { facing?: string }) =>
    facing ? `/tmp/camera-${facing}.jpg` : "/tmp/camera.jpg",
  ),
  parseCameraClipPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 3000,
    hasAudio: true,
  })),
  parseCameraSnapPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "jpg",
    width: 800,
    height: 600,
  })),
  resolveCameraClipTarget: vi.fn((params: { facing: "front" | "back"; platform?: string }) =>
    params.platform === "linux"
      ? { artifactFacing: "unknown" }
      : { requestFacing: params.facing, artifactFacing: params.facing },
  ),
  resolveCameraSnapTargets: vi.fn(
    (params: { facing: "front" | "back" | "both"; platform?: string; deviceId?: string }) => {
      if (params.platform === "linux") {
        return [{ artifactFacing: "unknown" }];
      }
      const facings = params.facing === "both" ? (["front", "back"] as const) : [params.facing];
      return facings.map((facing) => ({ requestFacing: facing, artifactFacing: facing }));
    },
  ),
  writeCameraClipPayloadToFile: vi.fn(async ({ facing }: { facing?: string }) =>
    facing ? `/tmp/camera-${facing}.mp4` : "/tmp/camera.mp4",
  ),
  writeCameraPayloadToFile: vi.fn(async () => undefined),
}));

const screenMocks = vi.hoisted(() => ({
  parseScreenRecordPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 300_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
  })),
  screenRecordTempPath: vi.fn(() => "/tmp/screen-record.mp4"),
  writeScreenRecordToFile: vi.fn(async () => ({ path: "/tmp/screen-record.mp4" })),
  parseScreenSnapshotPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "png",
    screenIndex: 0,
    width: 1920,
    height: 1080,
  })),
  screenSnapshotTempPath: vi.fn(() => "/tmp/screen-snapshot.png"),
  writeScreenSnapshotToFile: vi.fn(async () => ({ path: "/tmp/screen-snapshot.png" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: nodeUtilsMocks.resolveNodeId,
  resolveNode: nodeUtilsMocks.resolveNode,
}));

vi.mock("../../cli/nodes-camera.js", () => ({
  cameraTempPath: nodesCameraMocks.cameraTempPath,
  parseCameraClipPayload: nodesCameraMocks.parseCameraClipPayload,
  parseCameraSnapPayload: nodesCameraMocks.parseCameraSnapPayload,
  resolveCameraClipTarget: nodesCameraMocks.resolveCameraClipTarget,
  resolveCameraSnapTargets: nodesCameraMocks.resolveCameraSnapTargets,
  writeCameraClipPayloadToFile: nodesCameraMocks.writeCameraClipPayloadToFile,
  writeCameraPayloadToFile: nodesCameraMocks.writeCameraPayloadToFile,
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
  parseScreenSnapshotPayload: screenMocks.parseScreenSnapshotPayload,
  screenSnapshotTempPath: screenMocks.screenSnapshotTempPath,
  writeScreenSnapshotToFile: screenMocks.writeScreenSnapshotToFile,
}));

let createNodesTool: typeof import("./nodes-tool.js").createNodesTool;

function mockNodePairApproveFlow(pendingRequest: {
  requiredApproveScopes?: string[];
  commands?: string[];
}): void {
  // Pairing approval is two-step by design: list pending requests under the
  // operator scope, then approve with the request's required scopes.
  gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
    if (method === "node.pair.list") {
      return {
        pending: [
          {
            requestId: "req-1",
            ...pendingRequest,
          },
        ],
      };
    }
    if (method === "node.pair.approve") {
      return { ok: true, method, params, extra };
    }
    throw new Error(`unexpected method: ${String(method)}`);
  });
}

function expectNodePairApproveScopes(scopes: string[]): void {
  expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
    1,
    "node.pair.list",
    {},
    {},
    { scopes: ["operator.pairing"] },
  );
  expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
    2,
    "node.pair.approve",
    {},
    { requestId: "req-1" },
    { scopes },
  );
}

describe("createNodesTool screen_record duration guardrails", () => {
  beforeAll(async () => {
    // The agents lane runs on the shared non-isolated runner, so clear any
    // cached prior import before wiring this file's gateway/media mocks.
    vi.resetModules();
    ({ createNodesTool } = await import("./nodes-tool.js"));
  });

  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockClear();
    nodeUtilsMocks.resolveNode.mockClear();
    screenMocks.parseScreenRecordPayload.mockClear();
    screenMocks.writeScreenRecordToFile.mockClear();
    screenMocks.parseScreenSnapshotPayload.mockClear();
    screenMocks.screenSnapshotTempPath.mockClear();
    screenMocks.writeScreenSnapshotToFile.mockClear();
    nodesCameraMocks.cameraTempPath.mockClear();
    nodesCameraMocks.parseCameraClipPayload.mockReset();
    nodesCameraMocks.parseCameraClipPayload.mockReturnValue({
      base64: "ZmFrZQ==",
      format: "mp4",
      durationMs: 3000,
      hasAudio: true,
    });
    nodesCameraMocks.parseCameraSnapPayload.mockClear();
    nodesCameraMocks.writeCameraClipPayloadToFile.mockReset();
    nodesCameraMocks.writeCameraClipPayloadToFile.mockImplementation(
      async ({ facing }: { facing?: string }) =>
        facing ? `/tmp/camera-${facing}.mp4` : "/tmp/camera.mp4",
    );
    nodesCameraMocks.writeCameraPayloadToFile.mockClear();
  });

  it("bounds durationMs schema to positive values capped at 300000", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        durationMs?: {
          minimum?: number;
          maximum?: number;
          type?: string;
        };
      };
    };
    expect(schema.properties?.durationMs?.type).toBe("integer");
    expect(schema.properties?.durationMs?.minimum).toBe(1);
    expect(schema.properties?.durationMs?.maximum).toBe(300_000);
  });

  it("bounds photos_latest limit schema to positive values capped at 20", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        limit?: {
          minimum?: number;
          maximum?: number;
          type?: string;
        };
      };
    };
    expect(schema.properties?.limit?.type).toBe("integer");
    expect(schema.properties?.limit?.minimum).toBe(1);
    expect(schema.properties?.limit?.maximum).toBe(20);
  });

  it("advertises node media numeric constraints in the tool schema", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        maxWidth?: { minimum?: number; type?: string };
        quality?: { minimum?: number; maximum?: number; type?: string };
        delayMs?: { minimum?: number; type?: string };
        fps?: { exclusiveMinimum?: number; type?: string };
        screenIndex?: { minimum?: number; type?: string };
      };
    };
    expect(schema.properties?.maxWidth).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties?.quality).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(schema.properties?.delayMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties?.fps).toMatchObject({ type: "number", exclusiveMinimum: 0 });
    expect(schema.properties?.screenIndex).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("advertises node command timeout constraints in the tool schema", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        timeoutMs?: { minimum?: number; type?: string };
        maxAgeMs?: { minimum?: number; type?: string };
        locationTimeoutMs?: { minimum?: number; type?: string };
        invokeTimeoutMs?: { minimum?: number; type?: string };
      };
    };
    expect(schema.properties?.timeoutMs).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties?.maxAgeMs).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties?.locationTimeoutMs).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties?.invokeTimeoutMs).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("guides node discovery before describe", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: { node?: { description?: string } };
    };

    expect(tool.description).toContain("Paired nodes: status/list");
    expect(tool.description).toContain("pass node to describe/control");
    expect(schema.properties?.node?.description).toBe(
      "Node ID, name, or IP. Required for describe and node-targeted actions; use status to discover nodes.",
    );
  });

  it("advertises typed executable lookup instead of requiring raw invoke JSON", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        action?: { enum?: string[] };
        bins?: {
          type?: string;
          minItems?: number;
          maxItems?: number;
          items?: { type?: string; minLength?: number };
          description?: string;
        };
      };
    };

    expect(tool.description).toContain("executable lookup (which + bins)");
    expect(schema.properties?.action?.enum).toContain("which");
    expect(schema.properties?.bins).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1 },
      description: "which: executable names to resolve on the selected node.",
    });
  });

  it("requires an explicit node for describe and points to status", async () => {
    const tool = createNodesTool();

    await expect(tool.execute("call-describe", { action: "describe" })).rejects.toThrow(
      'node required for describe; call nodes with action="status" to list nodes, then retry with node',
    );
    expect(nodeUtilsMocks.resolveNodeId).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("resolves and describes the explicit node", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ nodeId: "node-1" });
    const tool = createNodesTool();

    await tool.execute("call-describe", { action: "describe", node: "Office Mac" });

    expect(nodeUtilsMocks.resolveNodeId).toHaveBeenCalledWith({}, "Office Mac");
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.describe",
      {},
      {
        nodeId: "node-1",
      },
    );
  });

  it.each(["screen_record", "camera_clip"])(
    "clamps %s to the tool duration limit and budgets both timeout layers",
    async (action) => {
      gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
      nodesCameraMocks.parseCameraClipPayload.mockReturnValue({
        base64: "ZmFrZQ==",
        format: "mp4",
        durationMs: 300_000,
        hasAudio: true,
      });
      nodesCameraMocks.writeCameraClipPayloadToFile.mockResolvedValue("/tmp/clip.mp4");
      const tool = createNodesTool();

      await tool.execute(`call-${action}`, {
        action,
        node: "macbook",
        durationMs: 900_000,
      });

      const call = gatewayMocks.callGatewayTool.mock.calls[0] as
        | [string, unknown, { params?: { durationMs?: unknown }; timeoutMs?: unknown }]
        | undefined;
      expect(call?.[0]).toBe("node.invoke");
      expect(call?.[1]).toStrictEqual({ timeoutMs: 360_000 });
      expect(call?.[2].params?.durationMs).toBe(300_000);
      expect(call?.[2].timeoutMs).toBe(330_000);
    },
  );

  it("preserves independent explicit transport and node invoke timeouts", async () => {
    gatewayMocks.readGatewayCallOptions.mockReturnValueOnce({ timeoutMs: 5_000 });
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    await tool.execute("call-explicit-timeout", {
      action: "screen_record",
      node: "macbook",
      durationMs: 60_000,
      timeoutMs: 5_000,
      invokeTimeoutMs: 10_000,
    });

    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [string, unknown, { timeoutMs?: unknown }]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[1]).toStrictEqual({ timeoutMs: 5_000 });
    expect(call?.[2].timeoutMs).toBe(10_000);
  });

  it.each([
    ["screen_record", 0],
    ["screen_record", 1.5],
    ["camera_clip", -1],
    ["camera_clip", "1sec"],
  ])("rejects invalid %s durationMs value %s", async (action, durationMs) => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-invalid-duration", {
        action,
        node: "macbook",
        durationMs,
      }),
    ).rejects.toThrow("durationMs must be a positive integer");
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("invokes screen.snapshot with validated params and returns file details", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    const result = await tool.execute("call-snapshot", {
      action: "screen_snapshot",
      node: "macbook",
      screenIndex: 1,
      maxWidth: "1200",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [
          string,
          unknown,
          { command?: string; params?: { screenIndex?: unknown; maxWidth?: unknown } },
        ]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[2].command).toBe("screen.snapshot");
    expect(call?.[2].params).toEqual({ screenIndex: 1, maxWidth: 1200 });
    expect(screenMocks.parseScreenSnapshotPayload).toHaveBeenCalledWith({ ok: true });
    expect(screenMocks.screenSnapshotTempPath).toHaveBeenCalledWith({ ext: "png" });
    expect(screenMocks.writeScreenSnapshotToFile).toHaveBeenCalledWith(
      "/tmp/screen-snapshot.png",
      "ZmFrZQ==",
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "FILE:/tmp/screen-snapshot.png" }],
      details: {
        path: "/tmp/screen-snapshot.png",
        format: "png",
        screenIndex: 0,
        width: 1920,
        height: 1080,
        media: {
          mediaUrl: "/tmp/screen-snapshot.png",
        },
      },
    });
  });

  it("rejects unsupported screen.snapshot response formats before writing", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    screenMocks.parseScreenSnapshotPayload.mockReturnValueOnce({
      base64: "ZmFrZQ==",
      format: "webp",
      screenIndex: 0,
      width: 1920,
      height: 1080,
    });
    const tool = createNodesTool();

    await expect(
      tool.execute("call-snapshot", {
        action: "screen_snapshot",
        node: "macbook",
      }),
    ).rejects.toThrow("unsupported screen.snapshot format: webp");
    expect(screenMocks.writeScreenSnapshotToFile).not.toHaveBeenCalled();
  });

  it("rejects the removed run action", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "run",
        node: "macbook",
      }),
    ).rejects.toThrow("Unknown action: run");
  });
  it("returns camera snaps via details.media.mediaUrls", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    const result = await tool.execute("call-1", {
      action: "camera_snap",
      node: "macbook",
      facing: "front",
    });

    expect(result?.details).toEqual({
      snaps: [
        {
          facing: "front",
          path: "/tmp/camera-front.jpg",
          width: 800,
          height: 600,
        },
      ],
      media: {
        mediaUrls: ["/tmp/camera-front.jpg"],
      },
    });
    expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
  });

  it("captures one unknown-position snap for Linux facing requests", async () => {
    nodeUtilsMocks.resolveNode.mockResolvedValueOnce({
      nodeId: "linux-node",
      remoteIp: "127.0.0.1",
      platform: "linux",
    });
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    const result = await tool.execute("call-linux-camera", {
      action: "camera_snap",
      node: "linux-node",
      facing: "both",
      deviceId: "/dev/video2",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      command: "camera.snap",
      params: { facing: undefined, deviceId: "/dev/video2" },
    });
    expect(result?.details).toMatchObject({
      snaps: [{ facing: "unknown", path: "/tmp/camera-unknown.jpg" }],
    });
  });

  it("captures an unknown-position clip on Linux without forwarding facing", async () => {
    nodeUtilsMocks.resolveNode.mockResolvedValueOnce({
      nodeId: "linux-node",
      remoteIp: "127.0.0.1",
      platform: "linux",
    });
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    const result = await tool.execute("call-linux-clip", {
      action: "camera_clip",
      node: "linux-node",
      facing: "back",
      deviceId: "/dev/video2",
    });

    expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      command: "camera.clip",
      params: { facing: undefined, deviceId: "/dev/video2" },
    });
    expect(result?.details).toMatchObject({
      facing: "unknown",
      path: "/tmp/camera-unknown.mp4",
    });
  });

  it("returns latest photos via details.media.mediaUrls", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        photos: [
          { base64: "ZmFrZQ==", format: "jpg", width: 800, height: 600, createdAt: "now" },
          { base64: "YmFy", format: "jpg", width: 1024, height: 768 },
        ],
      },
    });
    nodesCameraMocks.cameraTempPath
      .mockReturnValueOnce("/tmp/photo-1.jpg")
      .mockReturnValueOnce("/tmp/photo-2.jpg");
    nodesCameraMocks.parseCameraSnapPayload
      .mockReturnValueOnce({
        base64: "ZmFrZQ==",
        format: "jpg",
        width: 800,
        height: 600,
      })
      .mockReturnValueOnce({
        base64: "YmFy",
        format: "jpg",
        width: 1024,
        height: 768,
      });
    const tool = createNodesTool();

    const result = await tool.execute("call-1", {
      action: "photos_latest",
      node: "macbook",
    });

    expect(result?.details).toEqual({
      photos: [
        {
          index: 0,
          path: "/tmp/photo-1.jpg",
          width: 800,
          height: 600,
          createdAt: "now",
        },
        {
          index: 1,
          path: "/tmp/photo-2.jpg",
          width: 1024,
          height: 768,
        },
      ],
      media: {
        mediaUrls: ["/tmp/photo-1.jpg", "/tmp/photo-2.jpg"],
      },
    });
    expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
  });

  it("rejects invalid photos_latest limit values before gateway invoke", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-photos-limit", {
        action: "photos_latest",
        node: "macbook",
        limit: 1.5,
      }),
    ).rejects.toThrow("limit must be a positive integer");
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("caps photos_latest limit at 20 before gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { photos: [] } });
    const tool = createNodesTool();

    await tool.execute("call-photos-limit", {
      action: "photos_latest",
      node: "macbook",
      limit: 99,
    });

    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [string, unknown, { params?: { limit?: unknown } }]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[2].params?.limit).toBe(20);
  });

  it.each([
    ["camera_snap", { maxWidth: 640.5 }, "maxWidth must be a positive integer"],
    ["camera_snap", { delayMs: -1 }, "delayMs must be a non-negative integer"],
    ["camera_snap", { quality: 1.1 }, "quality must be between 0 and 1"],
    ["photos_latest", { maxWidth: "wide" }, "maxWidth must be a positive integer"],
    ["photos_latest", { quality: -0.1 }, "quality must be between 0 and 1"],
    ["screen_record", { fps: 0 }, "fps must be greater than 0"],
    ["screen_record", { screenIndex: 1.5 }, "screenIndex must be a non-negative integer"],
    ["screen_snapshot", { maxWidth: 0 }, "maxWidth must be a positive integer"],
    ["screen_snapshot", { screenIndex: -1 }, "screenIndex must be a non-negative integer"],
  ])("rejects invalid %s numeric params %s", async (action, params, message) => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-invalid-media-number", {
        action,
        node: "macbook",
        ...params,
      }),
    ).rejects.toThrow(message);
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("forwards validated camera_snap numeric params to gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    await tool.execute("call-camera-numbers", {
      action: "camera_snap",
      node: "macbook",
      facing: "front",
      maxWidth: "640",
      quality: "0.8",
      delayMs: "2000",
    });

    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [string, unknown, { params?: { maxWidth?: unknown; quality?: unknown; delayMs?: unknown } }]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[2].params).toMatchObject({
      maxWidth: 640,
      quality: 0.8,
      delayMs: 2000,
    });
  });

  it.each([
    ["location_get", { maxAgeMs: -1 }, "maxAgeMs must be a non-negative integer"],
    ["location_get", { locationTimeoutMs: 0 }, "locationTimeoutMs must be a positive integer"],
    [
      "invoke",
      { invokeCommand: "device.status", invokeTimeoutMs: "15s" },
      "invokeTimeoutMs must be a positive integer",
    ],
  ])("rejects invalid %s command numeric params %s", async (action, params, message) => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-invalid-command-number", {
        action,
        node: "macbook",
        ...params,
      }),
    ).rejects.toThrow(message);
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("forwards validated location_get numeric params to gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { lat: 1, lon: 2 } });
    const tool = createNodesTool();

    await tool.execute("call-location-numbers", {
      action: "location_get",
      node: "macbook",
      maxAgeMs: "5000",
      locationTimeoutMs: "10000",
    });

    const call = gatewayMocks.callGatewayTool.mock.calls[0] as
      | [string, unknown, { params?: { maxAgeMs?: unknown; timeoutMs?: unknown } }]
      | undefined;
    expect(call?.[0]).toBe("node.invoke");
    expect(call?.[2].params).toMatchObject({
      maxAgeMs: 5000,
      timeoutMs: 10000,
    });
  });

  it("preserves explicit null location_get payloads from node.invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: null });
    const tool = createNodesTool();

    const result = await tool.execute("call-location-null", {
      action: "location_get",
      node: "macbook",
    });

    expect(result.details).toBeNull();
    expect(result.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("forwards typed which bins to system.which", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: { bins: ["hostname"], paths: { hostname: "/bin/hostname" } },
    });
    const tool = createNodesTool();

    const result = await tool.execute("call-which", {
      action: "which",
      node: "macbook",
      bins: ["hostname"],
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      {
        nodeId: "node-1",
        command: "system.which",
        params: { bins: ["hostname"] },
        idempotencyKey: expect.any(String),
      },
    );
    expect(result.details).toEqual({
      bins: ["hostname"],
      paths: { hostname: "/bin/hostname" },
    });
  });

  it("rejects which without bins before gateway invoke", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-which-missing-bins", {
        action: "which",
        node: "macbook",
      }),
    ).rejects.toThrow("bins required");
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("uses operator.pairing plus operator.admin to approve exec-capable node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing", "operator.admin"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.admin"]);
  });

  it("uses operator.pairing plus operator.write to approve non-exec node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing", "operator.write"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.write"]);
  });

  it("uses operator.pairing for commandless node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing"]);
  });

  it("falls back to command inspection when the gateway does not advertise required scopes", async () => {
    mockNodePairApproveFlow({
      commands: ["canvas.snapshot"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.write"]);
  });

  it("blocks invokeCommand system.run so exec stays the only shell path", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "system.run",
      }),
    ).rejects.toThrow('invokeCommand "system.run" is reserved for shell execution');
  });

  it("forwards the owning agent session for generic node invokes", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool({ agentSessionKey: "agent:main:canvas" });

    await tool.execute("call-1", {
      action: "invoke",
      node: "macbook",
      invokeCommand: "device.status",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        command: "device.status",
        sessionKey: "agent:main:canvas",
      }),
    );
  });

  it("blocks raw computer.act so desktop input uses the dedicated safety contract", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "computer.act",
        invokeParamsJson: '{"action":"left_click","x":1,"y":1}',
      }),
    ).rejects.toThrow("use the dedicated computer tool");
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("redirects file-transfer invoke commands to the dedicated file-transfer tool", async () => {
    const tool = createNodesTool({ allowMediaInvokeCommands: true });

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "file.fetch",
      }),
    ).rejects.toThrow(
      'invokeCommand "file.fetch" enforces a path-allowlist policy and cannot be invoked via the generic nodes.invoke surface; use the dedicated file-transfer tool "file_fetch"',
    );
  });

  it("blocks raw screen.snapshot invoke to prevent base64 context bloat", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "screen.snapshot",
      }),
    ).rejects.toThrow('use action="screen_snapshot"');
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves explicitly enabled raw screen.snapshot invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: { format: "png", base64: "ZmFrZQ==" },
    });
    const tool = createNodesTool({ allowMediaInvokeCommands: true });

    await tool.execute("call-1", {
      action: "invoke",
      node: "macbook",
      invokeCommand: "screen.snapshot",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({ command: "screen.snapshot" }),
    );
  });

  it("keeps invoke pairing guidance for scope upgrade rejections", async () => {
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(
      new Error("scope upgrade pending approval (requestId: req-123)"),
    );
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "device.status",
      }),
    ).rejects.toThrow(
      "pairing required before node invoke. Approve pairing request req-123 and retry.",
    );
  });
});

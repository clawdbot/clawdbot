import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
  resolveNode: vi.fn(async () => ({ nodeId: "node-1" })),
  resolveNodeId: vi.fn(async () => "node-1"),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
  readGatewayCallOptions: mocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNode: mocks.resolveNode,
  resolveNodeId: mocks.resolveNodeId,
}));

import { executeNodeCommandAction } from "./nodes-tool-commands.js";
import { createNodesTool } from "./nodes-tool.js";

async function execute(input: Record<string, unknown>) {
  return await executeNodeCommandAction({
    action: "camera_ptz",
    input: { action: "camera_ptz", node: "Mac", ...input },
    gatewayOpts: {},
    mediaInvokeActions: {},
  });
}

describe("nodes camera_ptz", () => {
  beforeEach(() => {
    mocks.callGatewayTool.mockReset();
    mocks.callGatewayTool.mockResolvedValue({ payload: { deviceId: "camera-id", axes: {} } });
    mocks.resolveNodeId.mockClear();
  });

  it("advertises physical PTZ and its closed operation schema", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: Record<
        "deviceId" | "ptzOperation" | "panDegrees" | "tiltDegrees" | "zoomPercent",
        { description?: string; enum?: string[]; type?: string }
      >;
      required?: string[];
    };

    expect(tool.description).toContain("physical camera pan/tilt/zoom");
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties).toMatchObject({
      deviceId: {
        description:
          "For camera_ptz, use a camera_list devices[].id value as deviceId; it is required and must not be guessed.",
        type: "string",
      },
      ptzOperation: {
        description:
          "camera_ptz operation. Call status before any control operation. status and home accept no axes; set uses absolute axes; move uses axis deltas. Never guess unsupported axes.",
        enum: ["status", "set", "move", "home"],
        type: "string",
      },
      panDegrees: {
        description:
          "camera_ptz pan: set uses absolute degrees; move uses a degree delta. Omit when unsupported.",
        type: "number",
      },
      tiltDegrees: {
        description:
          "camera_ptz tilt: set uses absolute degrees; move uses a degree delta. Omit when unsupported.",
        type: "number",
      },
      zoomPercent: {
        description:
          "camera_ptz zoom: set uses absolute percent; move uses a percentage-point delta. Omit when unsupported.",
        type: "number",
      },
    });
  });

  it("routes status to the safe command with an explicit device id", async () => {
    const result = await execute({ deviceId: "camera-id", ptzOperation: "status" });

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      {
        nodeId: "node-1",
        command: "camera.ptz.status",
        params: { deviceId: "camera-id" },
        idempotencyKey: expect.any(String),
      },
    );
    expect(result.details).toEqual({ deviceId: "camera-id", axes: {} });
  });

  it.each([
    [
      "set",
      { panDegrees: 10, zoomPercent: 40 },
      {
        deviceId: "camera-id",
        operation: "set",
        target: { panDegrees: 10, tiltDegrees: undefined, zoomPercent: 40 },
      },
    ],
    [
      "move",
      { tiltDegrees: -2.5 },
      {
        deviceId: "camera-id",
        operation: "move",
        delta: { panDegrees: undefined, tiltDegrees: -2.5, zoomPercent: undefined },
      },
    ],
  ])("routes %s axes under the closed operation field", async (operation, axes, expected) => {
    await execute({ deviceId: "camera-id", ptzOperation: operation, ...axes });

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({ command: "camera.ptz.control", params: expected }),
    );
  });

  it("routes home without axis state", async () => {
    await execute({ deviceId: "camera-id", ptzOperation: "home" });

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        command: "camera.ptz.control",
        params: { deviceId: "camera-id", operation: "home" },
      }),
    );
  });

  it.each([
    [{ ptzOperation: "status" }, "deviceId required"],
    [{ deviceId: "camera-id" }, "ptzOperation must be status|set|move|home"],
    [{ deviceId: "camera-id", ptzOperation: "set" }, "set requires at least one PTZ axis"],
    [
      { deviceId: "camera-id", ptzOperation: "home", panDegrees: 1 },
      "home does not accept axis values",
    ],
    [
      { deviceId: "camera-id", ptzOperation: "status", tiltDegrees: 1 },
      "status does not accept axis values",
    ],
    [
      { deviceId: "camera-id", ptzOperation: "move", zoomPercent: Number.NaN },
      "zoomPercent must be a finite number",
    ],
  ])("validates before invoking the node", async (input, message) => {
    await expect(execute(input)).rejects.toThrow(message);
    expect(mocks.resolveNodeId).not.toHaveBeenCalled();
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });
});

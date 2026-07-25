/**
 * computer tool node-resolution tests.
 *
 * Cover which paired node a call binds to: capability eligibility, explicit
 * node selectors, and the id-before-display-name precedence that keeps input
 * off the wrong machine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listNodesMock = vi.fn();
const callGatewayToolMock = vi.fn();
const sleepMock = vi.hoisted(() => vi.fn());
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes-utils.js")>();
  return { ...actual, listNodes: listNodesMock };
});

vi.mock("./gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.js")>();
  return { ...actual, callGatewayTool: callGatewayToolMock };
});

vi.mock("../utils/sleep.js", () => ({ sleep: sleepMock }));

const { createComputerTool } = await import("./computer-tool.js");

function macComputerNode(overrides?: Record<string, unknown>) {
  return {
    nodeId: "mac-1",
    displayName: "Studio",
    platform: "macos",
    connected: true,
    commands: ["screen.snapshot", "computer.act"],
    ...overrides,
  };
}

function screenshotPayload(screenIndex = 0, base64 = TINY_PNG_BASE64) {
  return {
    payload: {
      format: "png",
      base64,
      displayFrameId: `display-${screenIndex}-frame`,
      width: 1280,
      height: 800,
      screenIndex,
    },
  };
}

describe("createComputerTool node resolution", () => {
  beforeEach(() => {
    listNodesMock.mockReset();
    callGatewayToolMock.mockReset();
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  it("errors when no computer-capable node is connected", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ connected: false }),
      { nodeId: "phone", platform: "ios", connected: true, commands: [] },
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot" })).rejects.toThrow(
      /no connected computer-capable node/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each(["windows", "linux"])("resolves and executes on a capable %s node", async (platform) => {
    const nodeId = `${platform}-1`;
    listNodesMock.mockResolvedValue([
      {
        nodeId,
        displayName: `${platform} desktop`,
        platform,
        connected: true,
        commands: ["computer.act", "screen.snapshot"],
      },
    ]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });

    await expect(tool.execute("call", { action: "type", text: "hello" })).resolves.toBeDefined();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId, command: "computer.act" }),
      { signal: undefined },
    );
  });

  it("rejects a named node that is not computer-capable", async () => {
    listNodesMock.mockResolvedValue([
      { nodeId: "mac-2", platform: "macos", connected: true, commands: ["screen.snapshot"] },
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot", node: "mac-2" })).rejects.toThrow(
      /not computer-capable/,
    );
  });

  it("reports the eligible node ids when an exact id names an ineligible machine", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-disabled", commands: ["screen.snapshot"] }),
      macComputerNode({ nodeId: "mac-ready" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "mac-disabled" }),
    ).rejects.toThrow(/node "mac-disabled" is not computer-capable.*eligible node ids: mac-ready/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("never redirects an ineligible exact id to an eligible node with that display name", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({
        nodeId: "requested-desktop",
        displayName: "Disabled",
        commands: ["screen.snapshot"],
      }),
      macComputerNode({ nodeId: "mac-ready", displayName: "requested-desktop" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "requested-desktop" }),
    ).rejects.toThrow(/node "requested-desktop" is not computer-capable/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects a case-insensitive ineligible id before an eligible display-name match", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({
        nodeId: "Requested-Desktop",
        displayName: "Disabled",
        commands: ["screen.snapshot"],
      }),
      macComputerNode({ nodeId: "mac-ready", displayName: "requested-desktop" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "requested-desktop" }),
    ).rejects.toThrow(/is not computer-capable/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous eligible display-name match", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a", displayName: "Shared Desktop" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Shared Desktop" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", { action: "screenshot", node: "Shared Desktop" }),
    ).rejects.toThrow(
      /ambiguous node: Shared Desktop.*node=mac-a.*node=mac-b.*eligible computer-capable node ids: mac-a, mac-b/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("resolves an eligible node by display name", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-other", displayName: "Other Desktop" }),
      macComputerNode({ nodeId: "mac-ready", displayName: "Studio Desktop" }),
    ]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });

    await expect(
      tool.execute("call", { action: "screenshot", node: "Studio Desktop" }),
    ).resolves.toBeDefined();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "mac-ready", command: "screen.snapshot" }),
      { signal: undefined },
    );
  });

  it("selects an exact eligible id over an ineligible display-name collision", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-ready", displayName: "Studio" }),
      macComputerNode({ nodeId: "mac-off", displayName: "mac-ready", commands: [] }),
    ]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });

    await expect(
      tool.execute("call", { action: "screenshot", node: "mac-ready" }),
    ).resolves.toBeDefined();
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "mac-ready", command: "screen.snapshot" }),
      { signal: undefined },
    );
  });

  it("requires an explicit node when several computer-capable nodes are connected", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b" }),
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot" })).rejects.toThrow(
      /multiple computer-capable nodes connected; pass node explicitly: mac-a, mac-b/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects a node advertising computer.act without screen.snapshot", async () => {
    listNodesMock.mockResolvedValue([
      { nodeId: "desktop-1", platform: "windows", connected: true, commands: ["computer.act"] },
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot", node: "desktop-1" })).rejects.toThrow(
      /advertising computer\.act and screen\.snapshot/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });
});

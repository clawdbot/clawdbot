/**
 * computer tool tests.
 *
 * Cover the computer.act wire mapping and node resolution / arming behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listNodesMock = vi.fn();
const callGatewayToolMock = vi.fn();

vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes-utils.js")>();
  return { ...actual, listNodes: listNodesMock };
});

vi.mock("./gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.js")>();
  return { ...actual, callGatewayTool: callGatewayToolMock };
});

const { buildComputerActParams, createComputerTool, COMPUTER_ACT_COMMAND, COMPUTER_REF_WIDTH } =
  await import("./computer-tool.js");
const { DEFAULT_IMAGE_MAX_DIMENSION_PX } = await import("../image-sanitization.js");
// With no config the reference width is capped at the default sanitization limit.
const EFFECTIVE_REF_WIDTH = Math.min(COMPUTER_REF_WIDTH, DEFAULT_IMAGE_MAX_DIMENSION_PX);

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

describe("buildComputerActParams", () => {
  it("maps a left_click with coordinate and modifier text", () => {
    const wire = buildComputerActParams({
      action: "left_click",
      input: { coordinate: [12, 34], text: "shift" },
      screenIndex: 0,
    });
    expect(wire).toEqual({
      action: "left_click",
      x: 12,
      y: 34,
      modifiers: "shift",
      screenIndex: 0,
      refWidth: COMPUTER_REF_WIDTH,
    });
  });

  it("requires a coordinate for click actions", () => {
    expect(() =>
      buildComputerActParams({ action: "double_click", input: {}, screenIndex: 0 }),
    ).toThrow(/coordinate/);
  });

  it("maps left_click_drag with start and end coordinates", () => {
    const wire = buildComputerActParams({
      action: "left_click_drag",
      input: { startCoordinate: [1, 2], coordinate: [3, 4] },
      screenIndex: 1,
    });
    expect(wire).toMatchObject({
      action: "left_click_drag",
      fromX: 1,
      fromY: 2,
      x: 3,
      y: 4,
      screenIndex: 1,
    });
  });

  it("maps scroll direction and clamps amount", () => {
    const wire = buildComputerActParams({
      action: "scroll",
      input: { scrollDirection: "Down", scrollAmount: 999, text: "cmd" },
      screenIndex: 0,
    });
    expect(wire).toMatchObject({
      action: "scroll",
      scrollDirection: "down",
      scrollAmount: 100,
      modifiers: "cmd",
    });
  });

  it("rejects scroll without a valid direction", () => {
    expect(() => buildComputerActParams({ action: "scroll", input: {}, screenIndex: 0 })).toThrow(
      /scrollDirection/,
    );
  });

  it("maps type text and key combos", () => {
    expect(
      buildComputerActParams({ action: "type", input: { text: "hello" }, screenIndex: 0 }).text,
    ).toBe("hello");
    expect(
      buildComputerActParams({ action: "key", input: { text: "cmd+shift+t" }, screenIndex: 0 })
        .keys,
    ).toBe("cmd+shift+t");
  });

  it("maps hold_key duration to milliseconds", () => {
    const wire = buildComputerActParams({
      action: "hold_key",
      input: { text: "space", duration: 2 },
      screenIndex: 0,
    });
    expect(wire).toMatchObject({ action: "hold_key", keys: "space", durationMs: 2000 });
  });

  it("does not attach modifiers for keyboard actions", () => {
    const wire = buildComputerActParams({
      action: "type",
      input: { text: "hi", coordinate: [5, 6] },
      screenIndex: 0,
    });
    expect(wire.modifiers).toBeUndefined();
    // Keyboard actions ignore coordinate context.
    expect(wire.x).toBeUndefined();
  });
});

describe("createComputerTool schema", () => {
  it("publishes Codex-compatible fixed-size coordinate arrays", () => {
    const properties = (
      createComputerTool().parameters as {
        properties?: Record<string, Record<string, unknown>>;
      }
    ).properties;

    for (const key of ["coordinate", "startCoordinate"] as const) {
      const schema = properties?.[key];
      if (!schema) {
        throw new Error(`missing ${key} schema`);
      }
      expect(schema).toMatchObject({
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
      });
      expect(Array.isArray(schema.items)).toBe(false);
      expect(schema).not.toHaveProperty("additionalItems");
    }
  });
});

describe("createComputerTool node resolution", () => {
  beforeEach(() => {
    listNodesMock.mockReset();
    callGatewayToolMock.mockReset();
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

  it("rejects a named node that is not computer-capable", async () => {
    listNodesMock.mockResolvedValue([
      { nodeId: "mac-2", platform: "macos", connected: true, commands: ["screen.snapshot"] },
    ]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot", node: "mac-2" })).rejects.toThrow(
      /not computer-capable/,
    );
  });

  it("captures a screenshot through screen.snapshot and keeps it model-only", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue({
      payload: { format: "jpeg", base64: "AAAA", width: 1280, height: 800, screenIndex: 0 },
    });
    const tool = createComputerTool({ modelHasVision: true });
    const result = await tool.execute("call", { action: "screenshot" });
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        nodeId: "mac-1",
        command: "screen.snapshot",
        params: expect.objectContaining({ maxWidth: EFFECTIVE_REF_WIDTH, format: "jpeg" }),
      }),
    );
    // Desktop pixels stay model-only (#44759): never auto-delivered to chat.
    expect(result.details).toMatchObject({
      media: { outbound: false },
      refWidth: EFFECTIVE_REF_WIDTH,
    });
  });

  it("surfaces the arming hint when computer.act is not allowlisted", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        throw new Error(
          'node command not allowed: "computer.act" requires explicit gateway.nodes.allowCommands opt-in',
        );
      }
      // screen.snapshot succeeds so a frame is established before the click.
      return {
        payload: { format: "jpeg", base64: "AAAA", width: 1280, height: 800, screenIndex: 0 },
      };
    });
    const tool = createComputerTool({ modelHasVision: true });
    await tool.execute("call", { action: "screenshot" });
    await expect(
      tool.execute("call", { action: "left_click", coordinate: [10, 10] }),
    ).rejects.toThrow(/\/phone arm computer/);
  });

  it("fails closed when a coordinate action has no observed screenshot frame", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const tool = createComputerTool({ modelHasVision: true });
    // A click before any screenshot must not silently target display 0.
    await expect(
      tool.execute("call", { action: "left_click", coordinate: [5, 5] }),
    ).rejects.toThrow(/screenshot/i);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("targets the last screenshot's display when a coordinate action omits screenIndex", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const bodies: Array<{ command?: string; params?: Record<string, unknown> }> = [];
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      bodies.push(body as { command?: string; params?: Record<string, unknown> });
      return {
        payload: { format: "jpeg", base64: "AAAA", width: 1280, height: 800, screenIndex: 1 },
      };
    });
    const tool = createComputerTool({ modelHasVision: true });
    // The model looks at display 1, then clicks a coordinate from that screenshot
    // without repeating screenIndex.
    await tool.execute("call", { action: "screenshot", screenIndex: 1 });
    await tool.execute("call", { action: "left_click", coordinate: [10, 20] });
    const act = bodies.find((b) => b.command === COMPUTER_ACT_COMMAND);
    // Without display retention this would silently target display 0.
    expect(act?.params).toMatchObject({ action: "left_click", screenIndex: 1 });
  });

  it("does not inherit another node's frame when a coordinate action names a different node", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
    ]);
    callGatewayToolMock.mockResolvedValue({
      payload: { format: "jpeg", base64: "AAAA", width: 1280, height: 800, screenIndex: 0 },
    });
    const tool = createComputerTool({ modelHasVision: true });
    // Observe a frame on node A (screen 1).
    await tool.execute("call", { action: "screenshot", node: "mac-a", screenIndex: 1 });
    // A click naming node B must not apply node A's frame; it needs its own screenshot.
    await expect(
      tool.execute("call", { action: "left_click", node: "mac-b", coordinate: [1, 2] }),
    ).rejects.toThrow(/no screenshot of this node/i);
  });
});

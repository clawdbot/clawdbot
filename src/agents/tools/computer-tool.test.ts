/**
 * computer tool tests.
 *
 * Cover the computer.act wire mapping and node resolution / arming behavior.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../runtime/index.js";

const listNodesMock = vi.fn();
const callGatewayToolMock = vi.fn();
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function imageIdentity(data: string, mimeType = "image/png") {
  return createHash("sha256")
    .update(JSON.stringify([mimeType, data]))
    .digest("hex");
}

vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes-utils.js")>();
  return { ...actual, listNodes: listNodesMock };
});

vi.mock("./gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.js")>();
  return { ...actual, callGatewayTool: callGatewayToolMock };
});

const {
  buildComputerActParams,
  createComputerTool,
  invalidateComputerFrameIfMissing,
  COMPUTER_ACT_COMMAND,
  COMPUTER_REF_WIDTH,
  testing,
} = await import("./computer-tool.js");
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

function readFrameId(result: { details?: unknown }): string {
  const frameId = (result.details as { frameId?: unknown } | undefined)?.frameId;
  if (typeof frameId !== "string") {
    throw new Error("missing frameId");
  }
  return frameId;
}

function computerToolResult(
  toolCallId: string,
  content: Extract<AgentMessage, { role: "toolResult" }>["content"],
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: "computer",
    content,
    details: {},
    isError: false,
    timestamp: 1,
  } satisfies AgentMessage;
}

describe("computer screenshot context binding", () => {
  it("keeps coordinates valid while the tracked tool result image remains visible", () => {
    const contextEpoch = {
      value: 0,
      frameToolCallId: "shot-1",
      frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
    };

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [
          computerToolResult("shot-1", [
            { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
          ]),
        ],
      }),
    ).toBe(false);
    expect(contextEpoch).toEqual({
      value: 0,
      frameToolCallId: "shot-1",
      frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
    });
  });

  it("expires coordinates once the final context drops the tracked image", () => {
    const contextEpoch = {
      value: 0,
      frameToolCallId: "shot-1",
      frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
    };

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [computerToolResult("shot-1", [{ type: "text", text: "compacted" }])],
      }),
    ).toBe(true);
    expect(contextEpoch).toEqual({ value: 1 });
    expect(invalidateComputerFrameIfMissing({ contextEpoch, messages: [] })).toBe(false);
    expect(contextEpoch.value).toBe(1);
  });

  it("expires coordinates when image input is disabled at the model boundary", () => {
    const contextEpoch = {
      value: 3,
      frameToolCallId: "shot-1",
      frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
    };

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [
          computerToolResult("shot-1", [
            { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
          ]),
        ],
        imagesBlocked: true,
      }),
    ).toBe(true);
    expect(contextEpoch).toEqual({ value: 4 });
  });

  it("expires coordinates when middleware swaps the tracked screenshot", () => {
    const contextEpoch = {
      value: 5,
      frameToolCallId: "shot-1",
      frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
    };

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [
          computerToolResult("shot-1", [{ type: "image", data: "AQ==", mimeType: "image/png" }]),
        ],
      }),
    ).toBe(true);
    expect(contextEpoch).toEqual({ value: 6 });
  });

  it("cleans up an orphaned image identity", () => {
    const contextEpoch = {
      value: 8,
      frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
    };

    expect(invalidateComputerFrameIfMissing({ contextEpoch, messages: [] })).toBe(true);
    expect(contextEpoch).toEqual({ value: 9 });
  });
});

describe("buildComputerActParams", () => {
  it("maps a left_click with coordinate and modifier text", () => {
    const wire = buildComputerActParams({
      action: "left_click",
      input: { coordinate: [12, 34], text: "shift" },
      screenIndex: 0,
      displayFrameId: "display-0-frame",
    });
    expect(wire).toEqual({
      action: "left_click",
      displayFrameId: "display-0-frame",
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

  it("enforces hold_key duration independently from the longer wait limit", () => {
    expect(
      buildComputerActParams({
        action: "hold_key",
        input: { text: "space", duration: 10 },
        screenIndex: 0,
      }),
    ).toMatchObject({ durationMs: 10_000 });
    expect(() =>
      buildComputerActParams({
        action: "hold_key",
        input: { text: "space", duration: 0 },
        screenIndex: 0,
      }),
    ).toThrow(/duration must be >0 and <=10 seconds/);
    expect(() =>
      buildComputerActParams({
        action: "hold_key",
        input: { text: "space", duration: 11 },
        screenIndex: 0,
      }),
    ).toThrow(/duration must be >0 and <=10 seconds/);
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

  it.each([
    { coordinate: [null, 2] },
    { coordinate: [false, 2] },
    { coordinate: ["1", 2] },
    { coordinate: [-1, 2] },
    { coordinate: [1.5, 2] },
    { coordinate: [1] },
    { coordinate: [1, 2, 3] },
  ])("rejects malformed coordinate input %#", (input) => {
    expect(() => buildComputerActParams({ action: "left_click", input, screenIndex: 0 })).toThrow(
      /coordinate/,
    );
  });

  it.each([null, "1,2", [1], [1, 2, 3], [1, false]])(
    "rejects a malformed optional coordinate %# instead of acting at the cursor",
    (coordinate) => {
      expect(() =>
        buildComputerActParams({
          action: "left_mouse_down",
          input: { coordinate },
          screenIndex: 0,
        }),
      ).toThrow(/coordinate/);
    },
  );
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
        items: { type: "integer", minimum: 0 },
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
    // Mapping and state tests do not need the real desktop's 500ms settle.
    testing.setWaitForPostActionSettleForTest(async (signal) => signal?.throwIfAborted());
  });

  afterEach(() => {
    testing.setWaitForPostActionSettleForTest();
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
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
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
      { signal: undefined },
    );
    // Desktop pixels stay model-only (#44759): never auto-delivered to chat.
    expect(result.details).toMatchObject({
      media: { outbound: false },
      refWidth: EFFECTIVE_REF_WIDTH,
    });
  });

  it("derives a stable node idempotency key from the run and tool call", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tool = createComputerTool({
        modelHasVision: true,
        idempotencyScope: "run-1",
      });
      await tool.execute("call-computer-1", { action: "type", text: "hello" });
    }

    const actKeys = callGatewayToolMock.mock.calls
      .map((call) => call[2] as { command?: string; idempotencyKey?: string })
      .filter((body) => body.command === COMPUTER_ACT_COMMAND)
      .map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[0]).toMatch(/^computer\.act:v1:[0-9a-f]{64}$/);
    expect(actKeys[1]).toBe(actKeys[0]);
  });

  it("does not share node receipts across runs that reuse a tool call id", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());

    for (const idempotencyScope of ["run-1", "run-2"]) {
      const tool = createComputerTool({ modelHasVision: true, idempotencyScope });
      await tool.execute("call-computer-1", { action: "type", text: "hello" });
    }

    const actKeys = callGatewayToolMock.mock.calls
      .map((call) => call[2] as { command?: string; idempotencyKey?: string })
      .filter((body) => body.command === COMPUTER_ACT_COMMAND)
      .map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[1]).not.toBe(actKeys[0]);
  });

  it("does not share node receipts when no stable run scope is available", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });

    await tool.execute("reused-call-id", { action: "type", text: "first" });
    await tool.execute("reused-call-id", { action: "type", text: "second" });

    const actKeys = callGatewayToolMock.mock.calls
      .map((call) => call[2] as { command?: string; idempotencyKey?: string })
      .filter((body) => body.command === COMPUTER_ACT_COMMAND)
      .map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[0]).not.toBe(actKeys[1]);
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
      return screenshotPayload();
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("call", { action: "screenshot" });
    await expect(
      tool.execute("call", {
        action: "left_click",
        coordinate: [10, 10],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/\/phone arm computer/);
  });

  it("surfaces the arming hint for the fresh-setup denylist rejection", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        throw new Error(
          'node command not allowed: "computer.act" is blocked by gateway.nodes.denyCommands',
        );
      }
      return screenshotPayload();
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("call", { action: "screenshot" });
    await expect(
      tool.execute("call", {
        action: "left_click",
        coordinate: [10, 10],
        frameId: readFrameId(screenshot),
      }),
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

  it("expires screenshot coordinates when compaction removes the image context", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const contextEpoch = { value: 0 };
    const tool = createComputerTool({ modelHasVision: true, contextEpoch });
    const screenshot = await tool.execute("shot", { action: "screenshot" });

    contextEpoch.value += 1;

    await expect(
      tool.execute("click", {
        action: "left_click",
        coordinate: [5, 5],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/screenshot/i);
    expect(
      callGatewayToolMock.mock.calls.filter(
        (call) => (call[2] as { command?: string }).command === COMPUTER_ACT_COMMAND,
      ),
    ).toHaveLength(0);
  });

  it("does not let an explicit screen index substitute for an observed frame", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(
      tool.execute("call", {
        action: "left_click",
        coordinate: [5, 5],
        screenIndex: 0,
        frameId: "guessed",
      }),
    ).rejects.toThrow(/screenshot/i);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid screen index instead of clamping it to display zero", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const tool = createComputerTool({ modelHasVision: true });
    await expect(tool.execute("call", { action: "screenshot", screenIndex: -1 })).rejects.toThrow(
      /screenIndex must be a non-negative integer/,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("targets the last screenshot's display when a coordinate action omits screenIndex", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const bodies: Array<{ command?: string; params?: Record<string, unknown> }> = [];
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      bodies.push(body as { command?: string; params?: Record<string, unknown> });
      return screenshotPayload(1);
    });
    const tool = createComputerTool({ modelHasVision: true });
    // The model looks at display 1, then clicks a coordinate from that screenshot
    // without repeating screenIndex.
    const screenshot = await tool.execute("call", { action: "screenshot", screenIndex: 1 });
    await tool.execute("call", {
      action: "left_click",
      coordinate: [10, 20],
      frameId: readFrameId(screenshot),
    });
    const act = bodies.find((b) => b.command === COMPUTER_ACT_COMMAND);
    // Without display retention this would silently target display 0.
    expect(act?.params).toMatchObject({
      action: "left_click",
      displayFrameId: "display-1-frame",
      screenIndex: 1,
    });
  });

  it("refuses to arm coordinates from a snapshot without physical display identity", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue({
      payload: { format: "png", base64: TINY_PNG_BASE64, width: 1280, height: 800, screenIndex: 0 },
    });
    const tool = createComputerTool({ modelHasVision: true });

    await expect(tool.execute("call", { action: "screenshot" })).rejects.toThrow(
      /missing displayFrameId/,
    );
  });

  it("rejects a coordinate action that retargets a different display", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload(1));
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("call", { action: "screenshot", screenIndex: 1 });
    await expect(
      tool.execute("call", {
        action: "left_click",
        coordinate: [10, 20],
        screenIndex: 0,
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/screenIndex does not match/);
    expect(
      callGatewayToolMock.mock.calls.filter(
        (call) => (call[2] as { command?: string }).command === COMPUTER_ACT_COMMAND,
      ),
    ).toHaveLength(0);
  });

  it("does not inherit another node's frame when a coordinate action names a different node", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
    ]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });
    // Observe a frame on node A (screen 1).
    const screenshot = await tool.execute("call", {
      action: "screenshot",
      node: "mac-a",
      screenIndex: 1,
    });
    // A click naming node B must not apply node A's frame; it needs its own screenshot.
    await expect(
      tool.execute("call", {
        action: "left_click",
        node: "mac-b",
        coordinate: [1, 2],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/no screenshot of this node/i);
  });

  it("does not authorize coordinates when the model received no image", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: false });
    const screenshot = await tool.execute("call", { action: "screenshot" });
    await expect(
      tool.execute("call", {
        action: "left_click",
        coordinate: [1, 2],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/no screenshot/i);
  });

  it("does not authorize coordinates when screenshot sanitization omits the image", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload(0, "not-base64!!!"));
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("call", { action: "screenshot" });
    await expect(
      tool.execute("call", {
        action: "left_click",
        coordinate: [1, 2],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/no screenshot/i);
  });

  it("invalidates the old frame when the post-action screenshot fails", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    let screenshotCalls = 0;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      const command = (body as { command?: string }).command;
      if (command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      screenshotCalls += 1;
      if (screenshotCalls === 1) {
        return screenshotPayload();
      }
      throw new Error("capture failed");
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("call", { action: "screenshot" });
    const frameId = readFrameId(screenshot);
    await expect(
      tool.execute("call", { action: "left_click", coordinate: [1, 2], frameId }),
    ).resolves.toMatchObject({ details: { action: "left_click" } });
    await expect(
      tool.execute("call", { action: "left_click", coordinate: [2, 3], frameId }),
    ).rejects.toThrow(/no screenshot/i);
  });

  it("keeps target affinity for button release after a failed screenshot", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
    ]);
    let screenshotCalls = 0;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      screenshotCalls += 1;
      if (screenshotCalls === 1) {
        return screenshotPayload(1);
      }
      throw new Error("capture failed");
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("shot", {
      action: "screenshot",
      node: "mac-a",
      screenIndex: 1,
    });
    await tool.execute("down", {
      action: "left_mouse_down",
      coordinate: [1, 2],
      frameId: readFrameId(screenshot),
    });
    await expect(tool.execute("retarget", { action: "screenshot", node: "mac-b" })).rejects.toThrow(
      /left button may still be held on node mac-a/,
    );
    await tool.execute("up", { action: "left_mouse_up" });

    const actBodies = callGatewayToolMock.mock.calls
      .map(
        (call) =>
          call[2] as { nodeId?: string; command?: string; params?: Record<string, unknown> },
      )
      .filter((body) => body.command === COMPUTER_ACT_COMMAND);
    expect(actBodies).toHaveLength(2);
    expect(actBodies[0]).toMatchObject({
      nodeId: "mac-a",
      params: { action: "left_mouse_down", screenIndex: 1 },
    });
    expect(actBodies[1]).toMatchObject({
      nodeId: "mac-a",
      params: { action: "left_mouse_up", screenIndex: 1 },
    });
    expect(actBodies[1]?.params).not.toHaveProperty("displayFrameId");
  });

  it("clears button affinity when the gateway definitively rejects mouse down", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
    ]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        throw Object.assign(
          new Error(
            'node command not allowed: "computer.act" requires explicit gateway.nodes.allowCommands opt-in',
          ),
          { name: "GatewayClientRequestError" },
        );
      }
      return screenshotPayload();
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("shot", { action: "screenshot", node: "mac-a" });

    await expect(
      tool.execute("down", {
        action: "left_mouse_down",
        coordinate: [1, 2],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow(/computer control is disarmed/);
    await expect(
      tool.execute("retarget", { action: "screenshot", node: "mac-b" }),
    ).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("clears button affinity after a structured pre-dispatch policy rejection", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
    ]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        throw Object.assign(new Error("phone policy denied computer control"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { code: "POLICY_DENIED", nodeCommandDispatched: false },
        });
      }
      return screenshotPayload();
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("shot", { action: "screenshot", node: "mac-a" });

    await expect(
      tool.execute("down", {
        action: "left_mouse_down",
        coordinate: [1, 2],
        frameId: readFrameId(screenshot),
      }),
    ).rejects.toThrow("phone policy denied computer control");
    await expect(
      tool.execute("retarget", { action: "screenshot", node: "mac-b" }),
    ).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it.each([
    ["node timeout", "TIMEOUT: node invoke timed out", "UNAVAILABLE", undefined],
    ["gateway unavailable", "node disconnected (computer.act)", "UNAVAILABLE", undefined],
    [
      "post-dispatch policy rejection",
      "plugin rejected after dispatch",
      "INVALID_REQUEST",
      { nodeCommandDispatched: true },
    ],
  ])(
    "keeps button affinity after an ambiguous %s request error",
    async (_label, message, gatewayCode, details) => {
      listNodesMock.mockResolvedValue([
        macComputerNode({ nodeId: "mac-a" }),
        macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
      ]);
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
        const request = body as { command?: string; params?: { action?: string } };
        if (
          request.command === COMPUTER_ACT_COMMAND &&
          request.params?.action === "left_mouse_down"
        ) {
          throw Object.assign(new Error(message), {
            name: "GatewayClientRequestError",
            gatewayCode,
            details,
          });
        }
        return screenshotPayload();
      });
      const tool = createComputerTool({ modelHasVision: true });
      const screenshot = await tool.execute("shot", { action: "screenshot", node: "mac-a" });

      await expect(
        tool.execute("down", {
          action: "left_mouse_down",
          coordinate: [1, 2],
          frameId: readFrameId(screenshot),
        }),
      ).rejects.toThrow(message);
      await expect(
        tool.execute("retarget", { action: "screenshot", node: "mac-b" }),
      ).rejects.toThrow(/left button may still be held on node mac-a/);

      await expect(tool.execute("up", { action: "left_mouse_up" })).resolves.toBeDefined();
      await expect(
        tool.execute("retarget-after-release", { action: "screenshot", node: "mac-b" }),
      ).resolves.toMatchObject({ details: { node: "mac-b" } });
    },
  );

  it("does not claim button affinity when cancellation wins during target resolution", async () => {
    const controller = new AbortController();
    let listCalls = 0;
    listNodesMock.mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 2) {
        controller.abort(new Error("cancelled before dispatch"));
      }
      return [
        macComputerNode({ nodeId: "mac-a" }),
        macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
      ];
    });
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("shot", { action: "screenshot", node: "mac-a" });

    await expect(
      tool.execute(
        "down",
        {
          action: "left_mouse_down",
          coordinate: [1, 2],
          frameId: readFrameId(screenshot),
          node: "mac-a",
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled before dispatch");
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    await expect(
      tool.execute("retarget", { action: "screenshot", node: "mac-b" }),
    ).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("treats mouse up as idempotent after lifecycle cleanup released the button", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ nodeId: "mac-a" }),
      macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
    ]);
    let actCalls = 0;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        actCalls += 1;
        if (actCalls === 2) {
          throw Object.assign(
            new Error("INVALID_REQUEST: left button is not held by computer control"),
            { name: "GatewayClientRequestError" },
          );
        }
        return { payload: { ok: true } };
      }
      return screenshotPayload();
    });
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("shot", { action: "screenshot", node: "mac-a" });
    await tool.execute("down", {
      action: "left_mouse_down",
      coordinate: [1, 2],
      frameId: readFrameId(screenshot),
    });

    await expect(tool.execute("up", { action: "left_mouse_up" })).resolves.toBeDefined();
    await expect(
      tool.execute("retarget", { action: "screenshot", node: "mac-b" }),
    ).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("aborts a wait without taking the delayed screenshot", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    const controller = new AbortController();
    const tool = createComputerTool({ modelHasVision: true });
    const pending = tool.execute("call", { action: "wait", duration: 100 }, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/Aborted/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("propagates cancellation from the follow-up screenshot after input lands", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    let screenshotCalls = 0;
    let followupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      followupStarted = resolve;
    });
    callGatewayToolMock.mockImplementation(async (_method, _opts, body, extra) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      screenshotCalls += 1;
      if (screenshotCalls === 1) {
        return screenshotPayload();
      }
      followupStarted();
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      return await new Promise<never>((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const tool = createComputerTool({ modelHasVision: true });
    const screenshot = await tool.execute("shot", { action: "screenshot" });
    const pending = tool.execute(
      "click",
      { action: "left_click", coordinate: [1, 2], frameId: readFrameId(screenshot) },
      controller.signal,
    );
    await started;
    controller.abort(new Error("cancelled during follow-up"));

    await expect(pending).rejects.toThrow(/cancelled during follow-up/);
  });

  it("does not run a dangerous action that was aborted while queued", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    let releaseScreenshot!: () => void;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      await new Promise<void>((resolve) => {
        releaseScreenshot = resolve;
      });
      return screenshotPayload();
    });
    const tool = createComputerTool({ modelHasVision: true });
    const first = tool.execute("first", { action: "screenshot" });
    await vi.waitFor(() => expect(releaseScreenshot).toBeTypeOf("function"));
    const controller = new AbortController();
    const queued = tool.execute("queued", { action: "type", text: "never" }, controller.signal);
    controller.abort(new Error("cancelled"));
    releaseScreenshot();
    await first;
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(
      callGatewayToolMock.mock.calls.filter(
        (call) => (call[2] as { command?: string }).command === COMPUTER_ACT_COMMAND,
      ),
    ).toHaveLength(0);
  });
});

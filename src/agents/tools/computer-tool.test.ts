import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callGatewayToolMock,
  COMPUTER_ACT_COMMAND,
  type ComputerActBody,
  type ComputerTool,
  type ComputerToolOptions,
  createVisionComputerTool,
  EFFECTIVE_REF_WIDTH,
  listNodesMock,
  macComputerNode,
  readFrameId,
  readLastComputerActParams,
  resetComputerToolMocks,
  screenshotPayload,
  TINY_PNG_BASE64,
} from "./computer-tool.test-helpers.js";

const INVALID_SCROLL_AMOUNT = /scrollAmount must be a positive integer/;
const INVALID_HOLD_DURATION = /duration must be >0 and <=10 seconds/;

function expectedAct(action: string, fields: Record<string, unknown> = {}) {
  return { action, screenIndex: 0, refWidth: EFFECTIVE_REF_WIDTH, ...fields };
}

function twoMacComputerNodes() {
  return [
    macComputerNode({ nodeId: "mac-a" }),
    macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
  ];
}

function computerActBodies(): ComputerActBody[] {
  return callGatewayToolMock.mock.calls
    .map((call) => call[2] as ComputerActBody)
    .filter((body) => body.command === COMPUTER_ACT_COMMAND)
    .map((body) => {
      if (!body.params) {
        return body;
      }
      const { executionId: _executionId, ...params } = body.params;
      const sanitizedBody = Object.assign({}, body);
      sanitizedBody.params = params;
      return sanitizedBody;
    });
}

async function captureFrame(
  tool: ComputerTool,
  input: Record<string, unknown> = {},
  callId = "shot",
) {
  return readFrameId(await tool.execute(callId, { action: "screenshot", ...input }));
}

async function createToolWithFrame(
  options: ComputerToolOptions = {},
  input: Record<string, unknown> = {},
  callId = "shot",
) {
  const tool = createVisionComputerTool(options);
  return { tool, frameId: await captureFrame(tool, input, callId) };
}

function executeClick(
  tool: ComputerTool,
  frameId: string,
  input: Record<string, unknown> = {},
  callId = "click",
  signal?: AbortSignal,
) {
  return tool.execute(
    callId,
    { action: "left_click", coordinate: [1, 2], frameId, ...input },
    signal,
  );
}

function executeMouseDown(
  tool: ComputerTool,
  frameId: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return tool.execute(
    "down",
    { action: "left_mouse_down", coordinate: [1, 2], frameId, ...input },
    signal,
  );
}

function retargetToMacB(tool: ComputerTool, callId = "retarget") {
  return tool.execute(callId, { action: "screenshot", node: "mac-b" });
}

type InvalidCase = [string, Record<string, unknown>, RegExp];

function invalidScrollCase(name: string, scrollAmount: unknown): InvalidCase {
  return [name, { action: "scroll", scrollDirection: "down", scrollAmount }, INVALID_SCROLL_AMOUNT];
}

function invalidHoldCase(name: string, duration: unknown): InvalidCase {
  return [name, { action: "hold_key", text: "space", duration }, INVALID_HOLD_DURATION];
}

function mockComputerActError(error: Error, action?: string) {
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
    const request = body as ComputerActBody;
    if (
      request.command === COMPUTER_ACT_COMMAND &&
      (!action || request.params?.action === action)
    ) {
      throw error;
    }
    return request.command === COMPUTER_ACT_COMMAND
      ? { payload: { ok: true } }
      : screenshotPayload();
  });
}

function mockFirstScreenshotThenFailure(screenIndex = 0) {
  let screenshotCalls = 0;
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
    if ((body as ComputerActBody).command === COMPUTER_ACT_COMMAND) {
      return { payload: { ok: true } };
    }
    if ((screenshotCalls += 1) === 1) {
      return screenshotPayload(screenIndex);
    }
    throw new Error("capture failed");
  });
}

async function executeComputerAction(params: Record<string, unknown>) {
  const tool = createVisionComputerTool();
  const actionParams = { ...params };
  if (Object.hasOwn(params, "coordinate") || Object.hasOwn(params, "startCoordinate")) {
    const screenshot = await tool.execute("shot", { action: "screenshot" });
    actionParams.frameId = readFrameId(screenshot);
  }
  await tool.execute("act", actionParams);
  return readLastComputerActParams();
}

describe("createComputerTool v1 execution", () => {
  beforeEach(resetComputerToolMocks);

  it.each([
    [
      "maps left click through the computer.act execution path",
      { action: "left_click", coordinate: [12, 34], text: "shift" },
      expectedAct("left_click", {
        displayFrameId: "display-0-frame",
        x: 12,
        y: 34,
        modifiers: "shift",
      }),
    ],
    [
      "maps drag through the computer.act execution path",
      { action: "left_click_drag", startCoordinate: [1, 2], coordinate: [3, 4] },
      expectedAct("left_click_drag", {
        displayFrameId: "display-0-frame",
        fromX: 1,
        fromY: 2,
        x: 3,
        y: 4,
      }),
    ],
    [
      "maps scroll input without leaking pointer fields",
      { action: "scroll", scrollDirection: "Down", scrollAmount: 999, text: "cmd" },
      expectedAct("scroll", {
        scrollDirection: "down",
        scrollAmount: 100,
        modifiers: "cmd",
      }),
    ],
    [
      "maps type input without leaking pointer fields",
      { action: "type", text: "hello", coordinate: [5, 6] },
      expectedAct("type", { text: "hello" }),
    ],
    [
      "maps key input without leaking pointer fields",
      { action: "key", text: "cmd+shift+t" },
      expectedAct("key", { keys: "cmd+shift+t" }),
    ],
    [
      "maps hold key input without leaking pointer fields",
      { action: "hold_key", text: "space", duration: 10 },
      expectedAct("hold_key", { keys: "space", durationMs: 10_000 }),
    ],
  ])("%s", async (_name, params, expected) => {
    await expect(executeComputerAction(params)).resolves.toEqual(expected);
  });

  it("requires coordinates through the public execution path", async () => {
    const { tool, frameId } = await createToolWithFrame();

    await expect(tool.execute("act", { action: "double_click", frameId })).rejects.toThrow(
      /coordinate/,
    );
    expect(() => readLastComputerActParams()).toThrow(/missing computer\.act request/);
  });

  it.each([
    { coordinate: [null, 2] },
    { coordinate: [false, 2] },
    { coordinate: ["1", 2] },
    { coordinate: [-1, 2] },
    { coordinate: [1.5, 2] },
    { coordinate: [1] },
    { coordinate: [1, 2, 3] },
  ])("rejects malformed required coordinate input %#", async ({ coordinate }) => {
    await expect(executeComputerAction({ action: "left_click", coordinate })).rejects.toThrow(
      /coordinate/,
    );
  });

  it.each([
    { coordinate: null },
    { coordinate: "1,2" },
    { coordinate: [1] },
    { coordinate: [1, 2, 3] },
    { coordinate: [1, false] },
  ])(
    "rejects malformed optional coordinate input %# instead of acting at the cursor",
    async ({ coordinate }) => {
      await expect(
        executeComputerAction({ action: "left_mouse_down", coordinate }),
      ).rejects.toThrow(/coordinate/);
    },
  );

  it("captures a screenshot through screen.snapshot and keeps it model-only", async () => {
    const result = await createVisionComputerTool().execute("call", { action: "screenshot" });
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tool = createVisionComputerTool({ idempotencyScope: "run-1" });
      await tool.execute("call-computer-1", { action: "type", text: "hello" });
    }

    const actKeys = computerActBodies().map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[0]).toMatch(/^computer\.act:v1:[0-9a-f]{64}$/);
    expect(actKeys[1]).toBe(actKeys[0]);
  });

  it("does not share node receipts across runs that reuse a tool call id", async () => {
    for (const idempotencyScope of ["run-1", "run-2"]) {
      const tool = createVisionComputerTool({ idempotencyScope });
      await tool.execute("call-computer-1", { action: "type", text: "hello" });
    }

    const actKeys = computerActBodies().map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[1]).not.toBe(actKeys[0]);
  });

  it("does not share node receipts when no stable run scope is available", async () => {
    const tool = createVisionComputerTool();

    await tool.execute("reused-call-id", { action: "type", text: "first" });
    await tool.execute("reused-call-id", { action: "type", text: "second" });

    const actKeys = computerActBodies().map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[0]).not.toBe(actKeys[1]);
  });

  it.each([
    [
      "surfaces the node enablement hint when computer.act is not allowlisted",
      Object.assign(
        new Error(
          'node command not allowed: "computer.act" is not in the allowlist for platform "macos"',
        ),
        {
          name: "GatewayClientRequestError",
          details: { reason: "command not allowlisted", command: "computer.act" },
        },
      ),
      /enable Computer Control.*approve the pairing update/i,
    ],
    [
      "surfaces the persistent deny remediation",
      new Error(
        'node command not allowed: "computer.act" is blocked by gateway.nodes.commands.deny',
      ),
      /remove computer\.act from gateway\.nodes\.commands\.deny/,
    ],
  ])("%s", async (_name, error, expected) => {
    mockComputerActError(error);
    const { tool, frameId } = await createToolWithFrame({}, {}, "call");
    await expect(executeClick(tool, frameId, { coordinate: [10, 10] }, "call")).rejects.toThrow(
      expected,
    );
  });

  it("expires screenshot coordinates when compaction removes the image context", async () => {
    const contextEpoch = { value: 0 };
    const { tool, frameId } = await createToolWithFrame({ contextEpoch });

    contextEpoch.value += 1;

    await expect(executeClick(tool, frameId, { coordinate: [5, 5] })).rejects.toThrow(
      /screenshot/i,
    );
    expect(computerActBodies()).toHaveLength(0);
  });

  it.each([
    [
      "fails closed when a coordinate action has no observed screenshot frame",
      { action: "left_click", coordinate: [5, 5] },
      /screenshot/i,
    ],
    [
      "does not let an explicit screen index substitute for an observed frame",
      {
        action: "left_click",
        coordinate: [5, 5],
        screenIndex: 0,
        frameId: "guessed",
      },
      /screenshot/i,
    ],
    [
      "rejects an invalid screen index instead of clamping it to display zero",
      { action: "screenshot", screenIndex: -1 },
      /screenIndex must be a non-negative integer/,
    ],
  ])("%s", async (_name, input, error) => {
    await expect(createVisionComputerTool().execute("call", input)).rejects.toThrow(error);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each<InvalidCase>([
    invalidScrollCase("fractional scroll amount", 1.5),
    invalidScrollCase("zero scroll amount", 0),
    invalidScrollCase("negative scroll amount", -1),
    invalidScrollCase("boolean scroll amount", true),
    invalidScrollCase("string scroll amount", "many"),
    ["missing scroll direction", { action: "scroll" }, /scrollDirection/],
    invalidHoldCase("boolean hold duration", true),
    invalidHoldCase("zero hold duration", 0),
    invalidHoldCase("oversized hold duration", 11),
    ["boolean wait duration", { action: "wait", duration: true }, /duration must be 0-100 seconds/],
  ])("rejects invalid %s before invoking the node", async (_label, params, error) => {
    await expect(createVisionComputerTool().execute("call", params)).rejects.toThrow(error);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("targets the last screenshot's display when a coordinate action omits screenIndex", async () => {
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
        ? { payload: { ok: true } }
        : screenshotPayload(1),
    );
    const { tool, frameId } = await createToolWithFrame({}, { screenIndex: 1 }, "call");
    // The model looks at display 1, then clicks a coordinate from that screenshot
    // without repeating screenIndex.
    await executeClick(tool, frameId, { coordinate: [10, 20] }, "call");
    // Without display retention this would silently target display 0.
    expect(computerActBodies()[0]?.params).toMatchObject({
      action: "left_click",
      displayFrameId: "display-1-frame",
      screenIndex: 1,
    });
  });

  it("refuses to arm coordinates from a snapshot without physical display identity", async () => {
    callGatewayToolMock.mockResolvedValue({
      payload: { format: "png", base64: TINY_PNG_BASE64, width: 1280, height: 800, screenIndex: 0 },
    });
    await expect(
      createVisionComputerTool().execute("call", { action: "screenshot" }),
    ).rejects.toThrow(/missing displayFrameId/);
  });

  it("rejects a coordinate action that retargets a different display", async () => {
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
        ? { payload: { ok: true } }
        : screenshotPayload(1),
    );
    const { tool, frameId } = await createToolWithFrame({}, { screenIndex: 1 }, "call");
    await expect(
      executeClick(tool, frameId, { coordinate: [10, 20], screenIndex: 0 }, "call"),
    ).rejects.toThrow(/screenIndex does not match/);
    expect(computerActBodies()).toHaveLength(0);
  });

  it("does not inherit another node's frame when a coordinate action names a different node", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    // Observe a frame on node A (screen 1).
    const { tool, frameId } = await createToolWithFrame(
      {},
      { node: "mac-a", screenIndex: 1 },
      "call",
    );
    // A click naming node B must not apply node A's frame; it needs its own screenshot.
    await expect(executeClick(tool, frameId, { node: "mac-b" }, "call")).rejects.toThrow(
      /no screenshot of this node/i,
    );
  });

  it.each([
    [
      "does not authorize coordinates when the model received no image",
      { modelHasVision: false },
      TINY_PNG_BASE64,
    ],
    [
      "does not authorize coordinates when screenshot sanitization omits the image",
      {},
      "not-base64!!!",
    ],
  ])("%s", async (_name, options, base64) => {
    callGatewayToolMock.mockResolvedValue(screenshotPayload(0, base64));
    const { tool, frameId } = await createToolWithFrame(options, {}, "call");
    await expect(executeClick(tool, frameId, {}, "call")).rejects.toThrow(/no screenshot/i);
  });

  it("invalidates the old frame when the post-action screenshot fails", async () => {
    mockFirstScreenshotThenFailure();
    const { tool, frameId } = await createToolWithFrame({}, {}, "call");
    await expect(executeClick(tool, frameId, {}, "call")).resolves.toMatchObject({
      details: { action: "left_click" },
    });
    await expect(executeClick(tool, frameId, { coordinate: [2, 3] }, "call")).rejects.toThrow(
      /no screenshot/i,
    );
  });

  it("keeps target affinity for button release after a failed screenshot", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    mockFirstScreenshotThenFailure(1);
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a", screenIndex: 1 });
    await executeMouseDown(tool, frameId);
    await expect(retargetToMacB(tool)).rejects.toThrow(
      /left button may still be held on node mac-a/,
    );
    await tool.execute("up", { action: "left_mouse_up" });

    const actBodies = computerActBodies();
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

  it.each([
    [
      "clears button affinity when the gateway definitively rejects mouse down",
      Object.assign(new Error("node command rejected before dispatch"), {
        name: "GatewayClientRequestError",
        details: { reason: "command not allowlisted", command: "computer.act" },
      }),
      /enable Computer Control.*approve the pairing update/i,
    ],
    [
      "clears button affinity after a structured pre-dispatch policy rejection",
      Object.assign(new Error("phone policy denied computer control"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { code: "POLICY_DENIED", nodeCommandDispatched: false },
      }),
      "phone policy denied computer control",
    ],
  ])("%s", async (_name, error, expected) => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    mockComputerActError(error);
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });

    await expect(executeMouseDown(tool, frameId)).rejects.toThrow(expected);
    await expect(retargetToMacB(tool)).resolves.toMatchObject({ details: { node: "mac-b" } });
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
      listNodesMock.mockResolvedValue(twoMacComputerNodes());
      mockComputerActError(
        Object.assign(new Error(message), {
          name: "GatewayClientRequestError",
          gatewayCode,
          details,
        }),
        "left_mouse_down",
      );
      const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });

      await expect(executeMouseDown(tool, frameId)).rejects.toThrow(message);
      await expect(retargetToMacB(tool)).rejects.toThrow(
        /left button may still be held on node mac-a/,
      );

      await expect(tool.execute("up", { action: "left_mouse_up" })).resolves.toBeDefined();
      await expect(retargetToMacB(tool, "retarget-after-release")).resolves.toMatchObject({
        details: { node: "mac-b" },
      });
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
      return twoMacComputerNodes();
    });
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });

    await expect(
      executeMouseDown(tool, frameId, { node: "mac-a" }, controller.signal),
    ).rejects.toThrow("cancelled before dispatch");
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    await expect(retargetToMacB(tool)).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("treats mouse up as idempotent after lifecycle cleanup released the button", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
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
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });
    await executeMouseDown(tool, frameId);

    await expect(tool.execute("up", { action: "left_mouse_up" })).resolves.toBeDefined();
    await expect(retargetToMacB(tool)).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("aborts a wait without taking the delayed screenshot", async () => {
    const controller = new AbortController();
    const tool = createVisionComputerTool();
    const pending = tool.execute("call", { action: "wait", duration: 100 }, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/Aborted/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("propagates cancellation from the follow-up screenshot after input lands", async () => {
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
    const { tool, frameId } = await createToolWithFrame();
    const pending = executeClick(tool, frameId, {}, "click", controller.signal);
    await started;
    controller.abort(new Error("cancelled during follow-up"));

    await expect(pending).rejects.toThrow(/cancelled during follow-up/);
  });

  it("does not run a dangerous action that was aborted while queued", async () => {
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
    const tool = createVisionComputerTool();
    const first = tool.execute("first", { action: "screenshot" });
    await vi.waitFor(() => expect(releaseScreenshot).toBeTypeOf("function"));
    const controller = new AbortController();
    const queued = tool.execute("queued", { action: "type", text: "never" }, controller.signal);
    controller.abort(new Error("cancelled"));
    releaseScreenshot();
    await first;
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(computerActBodies()).toHaveLength(0);
  });
});

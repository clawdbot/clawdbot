/**
 * computer tool node-resolution tests.
 *
 * Cover which paired node a call binds to: capability eligibility, explicit
 * node selectors, and the id-before-display-name precedence that keeps input
 * off the wrong machine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ComputerToolTransport } from "./computer-tool.js";

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

vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));

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

  it("keeps a bound session desktop's frames, actions, and cleanup on its transport", async () => {
    listNodesMock.mockResolvedValue([macComputerNode()]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    const computerUse: NonNullable<ComputerToolTransport["computerUse"]> = {
      contractVersion: 2,
      provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
      actions: ["screenshot", "left_click", "get_window_state"],
      targets: ["screen", "window"],
      deliveryModes: ["foreground"],
      observations: ["image"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    };
    const resolveNode = vi.fn<ComputerToolTransport["resolveNode"]>(async (query) => {
      if (query !== undefined && query !== "session-desktop") {
        throw new Error("Computer target is bound to this session desktop");
      }
      return { nodeId: "session-desktop" };
    });
    const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) =>
      command === "screen.snapshot" ? screenshotPayload().payload : { ok: true },
    );
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createComputerTool({
      modelHasVision: true,
      transport: { computerUse, resolveNode, invoke },
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    expect(tool.description).toContain("this session's desktop");
    expect(tool.description).toContain("get_window_state");
    const selectors = ["node", "gatewayUrl", "gatewayToken", "timeoutMs"];
    const schema = tool.parameters as { properties: Record<string, unknown> };
    expect(schema.properties.action).toMatchObject({ enum: computerUse.actions });
    for (const selector of selectors) {
      expect(schema.properties).not.toHaveProperty(selector);
    }

    const screenshot = await tool.execute("observe", { action: "screenshot" });
    expect(screenshot.details).toMatchObject({ node: "session-desktop" });
    const frameId = (screenshot.details as { frameId: string }).frameId;
    await tool.execute("click", { action: "left_click", coordinate: [0, 0], frameId });
    await expect(
      tool.execute("wrong-desktop", { action: "screenshot", node: "mac-1" }),
    ).rejects.toThrow("bound to this session desktop");
    await cleanup?.("completion");

    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "screen.snapshot",
      "computer.act",
      "screen.snapshot",
      "computer.act",
    ]);
    const snapshotRequest = invoke.mock.calls[0]?.[0];
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      nodeId: "session-desktop",
      commandParams: {
        action: "left_click",
        displayFrameId: "display-0-frame",
        x: 0,
        y: 0,
      },
    });
    expect(invoke.mock.calls[3]?.[0]).toMatchObject({
      nodeId: "session-desktop",
      commandParams: {
        action: "__close_execution",
        executionId: snapshotRequest?.commandParams.executionId,
        reason: "completion",
      },
    });
    expect(listNodesMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(tool.description).toContain("this session's desktop");
    expect(tool.description).toContain("get_window_state");
    for (const selector of selectors) {
      expect(schema.properties).not.toHaveProperty(selector);
    }
    await expect(tool.execute("after-close", { action: "screenshot" })).rejects.toThrow(
      "computer: execution is closed",
    );
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("fences retained and queued calls while awaiting an in-flight capture before cleanup", async () => {
    const capture = createDeferredCore<unknown>();
    const captureStarted = createDeferredCore();
    const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) => {
      if (command === "screen.snapshot") {
        captureStarted.resolve();
        return await capture.promise;
      }
      return { ok: true };
    });
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createComputerTool({
      modelHasVision: true,
      transport: { resolveNode: async () => ({ nodeId: "session-desktop" }), invoke },
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    if (!cleanup) {
      throw new Error("Computer execution did not register cleanup");
    }

    const first = tool.execute("capture", { action: "screenshot" });
    await captureStarted.promise;
    const queued = expect(
      tool.execute("queued", { action: "type", text: "unsafe" }),
    ).rejects.toThrow("computer: execution is closed");
    const closing = cleanup("cancellation");
    const retained = expect(
      tool.execute("retained", { action: "type", text: "unsafe" }),
    ).rejects.toThrow("computer: execution is closed");
    expect(invoke).toHaveBeenCalledOnce();
    capture.resolve(screenshotPayload().payload);
    await first;
    await Promise.all([queued, retained, closing, cleanup("cancellation")]);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      nodeId: "session-desktop",
      command: "computer.act",
      commandParams: { action: "__close_execution", reason: "cancellation" },
    });
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    expect(listNodesMock).not.toHaveBeenCalled();
  });

  it.each(["paired", "session"] as const)(
    "reports cleanup failure only to the bound owner of a %s desktop",
    async (targetScope) => {
      const failure = new Error("desktop disconnected during cleanup");
      listNodesMock.mockResolvedValue([macComputerNode()]);
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
        if (body.command === "computer.act") {
          throw failure;
        }
        return screenshotPayload();
      });
      const invoke = vi.fn<ComputerToolTransport["invoke"]>(async ({ command }) => {
        if (command === "computer.act") {
          throw failure;
        }
        return screenshotPayload().payload;
      });
      let cleanup: ((reason: string) => Promise<void>) | undefined;
      const tool = createComputerTool({
        modelHasVision: true,
        transport:
          targetScope === "session"
            ? { resolveNode: async () => ({ nodeId: "session-desktop" }), invoke }
            : undefined,
        registerRunCleanup: (registered) => {
          cleanup = registered;
        },
      });
      if (!cleanup) {
        throw new Error("Computer execution did not register cleanup");
      }
      await tool.execute("observe", { action: "screenshot" });

      if (targetScope === "session") {
        await expect(cleanup("completion")).rejects.toMatchObject({
          message: "computer: session desktop cleanup failed",
          errors: [failure],
        });
      } else {
        await expect(cleanup("completion")).resolves.toBeUndefined();
      }
    },
  );

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
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as { command?: string }).command === "computer.act"
        ? { payload: { ok: true } }
        : screenshotPayload(),
    );
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

  it("rejects an ambiguous eligible display-name match across current clients", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({
        nodeId: "mac-a",
        displayName: "Shared Desktop",
        clientId: "openclaw-macos",
      }),
      macComputerNode({ nodeId: "mac-b", displayName: "Shared Desktop", clientId: "node-host" }),
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

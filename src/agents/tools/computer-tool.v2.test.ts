import { beforeEach, describe, expect, it } from "vitest";
import type { ComputerUseV2ActionName } from "../../plugins/computer-use-contract.js";
import {
  callGatewayToolMock,
  COMPUTER_ACT_COMMAND,
  type ComputerActBody,
  createVisionComputerTool,
  EFFECTIVE_REF_WIDTH,
  listNodesMock,
  macComputerNode,
  readActionEnum,
  readLastComputerActParams,
  resetComputerToolMocks,
  screenshotPayload,
  sleepMock,
  TINY_PNG_BASE64,
  v2Descriptor,
} from "./computer-tool.test-helpers.js";

describe("createComputerTool v2 execution", () => {
  beforeEach(resetComputerToolMocks);

  it("rebuilds the visible action enum from the selected node declaration", async () => {
    const actions: ComputerUseV2ActionName[] = ["screenshot", "list_apps", "get_window_state"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    const tool = createVisionComputerTool();
    expect(tool.description).not.toContain("get_window_state");

    await tool.execute("select", { action: "screenshot" });

    expect(readActionEnum(tool)).toEqual(actions);
    expect(tool.description).toContain("Observe first with `get_window_state`");
  });

  it("advertises execution-owned actions only with an attempt cleanup owner", async () => {
    const actions: ComputerUseV2ActionName[] = [
      "screenshot",
      "browser_download",
      "start_recording",
    ];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);

    const withoutCleanup = createVisionComputerTool();
    await withoutCleanup.execute("bind-without-cleanup", { action: "screenshot" });
    expect(readActionEnum(withoutCleanup)).toEqual(["screenshot"]);

    const withCleanup = createVisionComputerTool({ registerRunCleanup: () => {} });
    await withCleanup.execute("bind-with-cleanup", { action: "screenshot" });
    expect(readActionEnum(withCleanup)).toEqual(actions);
  });

  it("projects a provider observation without taking a duplicate desktop screenshot", async () => {
    const actions: ComputerUseV2ActionName[] = ["get_window_state"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockResolvedValue({
      payload: {
        ok: true,
        effect: "confirmed",
        observation: {
          kind: "window",
          base64: TINY_PNG_BASE64,
          format: "png",
          width: 1,
          height: 1,
          observationId: "observation-1",
          elements: [
            {
              elementRef: "element-1",
              role: "button",
              label: "Save",
              bounds: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
      },
    });
    const tool = createVisionComputerTool();

    const result = await tool.execute("observe", {
      action: "get_window_state",
      windowRef: "window-1",
    });

    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );
    expect(callGatewayToolMock).toHaveBeenCalledOnce();
    expect(readLastComputerActParams()).toEqual({
      action: "get_window_state",
      windowRef: "window-1",
    });
    expect(sleepMock).not.toHaveBeenCalledWith(500, expect.anything());
  });

  it("rejects stale semantic references before dispatch", async () => {
    const actions: ComputerUseV2ActionName[] = ["get_window_state", "set_value"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockResolvedValue({
      payload: {
        ok: true,
        observation: { kind: "window", observationId: "observation-current" },
      },
    });
    const tool = createVisionComputerTool();
    await tool.execute("observe", { action: "get_window_state", windowRef: "window-1" });
    callGatewayToolMock.mockClear();

    await expect(
      tool.execute("write", {
        action: "set_value",
        windowRef: "window-1",
        elementRef: "element-1",
        observationId: "observation-stale",
        value: "hello",
        deliveryMode: "background",
      }),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("maps browser observations and opaque refs through the public tool", async () => {
    const actions: ComputerUseV2ActionName[] = ["get_browser_state", "browser_pointer"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockResolvedValueOnce({
      payload: {
        ok: true,
        observation: { kind: "browser", observationId: "browser-observation-1" },
        details: {
          browserRef: "browser-1",
          pageRef: "page-1",
          elements: [{ elementRef: "element-1" }, { elementRef: "element-2" }],
        },
      },
    });
    const tool = createVisionComputerTool();

    await tool.execute("observe-browser", {
      action: "get_browser_state",
      browserRef: "browser-1",
      pageRef: "page-1",
      snapshotFormat: "dom_refs_v1",
      includeScreenshot: true,
    });
    expect(readLastComputerActParams()).toEqual({
      action: "get_browser_state",
      browserRef: "browser-1",
      pageRef: "page-1",
      snapshotFormat: "dom_refs_v1",
      includeScreenshot: true,
    });

    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
        ? { payload: { ok: true, effect: "confirmed" } }
        : screenshotPayload(),
    );
    await tool.execute("drag-browser", {
      action: "browser_pointer",
      browserRef: "browser-1",
      pageRef: "page-1",
      observationId: "browser-observation-1",
      pointerAction: "drag",
      inputRoute: "dom_event",
      elementRef: "element-1",
      destinationElementRef: "element-2",
    });
    expect(readLastComputerActParams()).toEqual({
      action: "browser_pointer",
      browserRef: "browser-1",
      pageRef: "page-1",
      observationId: "browser-observation-1",
      pointerAction: "drag",
      inputRoute: "dom_event",
      elementRef: "element-1",
      destinationElementRef: "element-2",
    });
  });

  it("routes an observation-bound element click without requiring coordinates", async () => {
    const actions: ComputerUseV2ActionName[] = ["get_window_state", "left_click"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      const request = body as ComputerActBody;
      if (request.command !== COMPUTER_ACT_COMMAND) {
        return screenshotPayload();
      }
      if (request.params?.action === "get_window_state") {
        return {
          payload: {
            ok: true,
            observation: {
              kind: "window",
              observationId: "observation-1",
            },
          },
        };
      }
      return { payload: { ok: true, effect: "confirmed" } };
    });
    const tool = createVisionComputerTool();
    await tool.execute("observe", { action: "get_window_state", windowRef: "window-1" });

    await expect(
      tool.execute("click", {
        action: "left_click",
        windowRef: "window-1",
        elementRef: "element-1",
        observationId: "observation-1",
        deliveryMode: "background",
      }),
    ).resolves.toBeDefined();
    expect(readLastComputerActParams()).toEqual({
      action: "left_click",
      screenIndex: 0,
      refWidth: EFFECTIVE_REF_WIDTH,
      windowRef: "window-1",
      elementRef: "element-1",
      observationId: "observation-1",
      deliveryMode: "background",
    });
  });

  it("maps the recording family through opaque resource parameters", async () => {
    const actions: ComputerUseV2ActionName[] = [
      "get_recording_state",
      "start_recording",
      "stop_recording",
      "replay_trajectory",
    ];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    const tool = createVisionComputerTool({ registerRunCleanup: () => {} });
    const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";

    await tool.execute("record", { action: "start_recording", recordVideo: true });
    expect(readLastComputerActParams()).toEqual({ action: "start_recording", recordVideo: true });
    await tool.execute("replay", {
      action: "replay_trajectory",
      resourceHandle,
      delayMs: 25,
      stopOnError: false,
    });
    expect(readLastComputerActParams()).toEqual({
      action: "replay_trajectory",
      resourceHandle,
      delayMs: 25,
      stopOnError: false,
    });
  });

  it("closes the exact host execution through attempt-owned cleanup", async () => {
    const actions: ComputerUseV2ActionName[] = ["start_recording"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createVisionComputerTool({
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });

    await tool.execute("record", { action: "start_recording" });
    const start = callGatewayToolMock.mock.calls
      .map((call) => call[2] as ComputerActBody)
      .findLast((body) => body.command === COMPUTER_ACT_COMMAND);
    if (!start?.params) {
      throw new Error("missing start_recording node invocation");
    }
    const executionId = start.params.executionId;
    expect(executionId).toEqual(expect.any(String));

    await cleanup?.("completion");

    const close = callGatewayToolMock.mock.calls.at(-1)?.[2] as ComputerActBody;
    expect(close.params).toEqual({
      action: "__close_execution",
      executionId,
      reason: "completion",
    });
  });
});

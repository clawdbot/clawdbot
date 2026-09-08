import { beforeEach, describe, expect, it } from "vitest";
import { getImageMetadata } from "../../media/image-ops.js";
import { createSolidPngBuffer } from "../../plugin-sdk/test-helpers/image-fixtures.js";
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
  v2Descriptor,
} from "./computer-tool.test-helpers.js";

describe("createComputerTool v2 execution", () => {
  beforeEach(resetComputerToolMocks);

  it("derives local wait from the selected node screenshot capability", async () => {
    const actions: ComputerUseV2ActionName[] = ["screenshot", "list_apps", "get_window_state"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    const tool = createVisionComputerTool();
    expect(tool.description).not.toContain("get_window_state");

    await tool.execute("select", { action: "wait", duration: 0 });

    expect(readActionEnum(tool)).toEqual([...actions, "wait"]);
    expect(sleepMock).toHaveBeenCalledWith(0, undefined);
    expect(
      callGatewayToolMock.mock.calls.map((call) => (call[2] as ComputerActBody).command),
    ).toEqual(["screen.snapshot"]);
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
    expect(readActionEnum(withoutCleanup)).toEqual(["screenshot", "wait"]);

    const withCleanup = createVisionComputerTool({ registerRunCleanup: () => {} });
    await withCleanup.execute("bind-with-cleanup", { action: "screenshot" });
    expect(readActionEnum(withCleanup)).toEqual([...actions, "wait"]);
  });

  it.each([
    {
      name: "missing screenshot capability",
      actions: ["list_apps"],
      error: "does not advertise action wait",
      captures: 0,
    },
    {
      name: "denied screenshot transport",
      actions: ["screenshot"],
      error: "snapshot policy denied",
      captures: 1,
    },
  ] as const)("keeps $name authoritative for local wait", async ({ actions, error, captures }) => {
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor([...actions]) })]);
    callGatewayToolMock.mockRejectedValue(new Error("snapshot policy denied"));
    const tool = createVisionComputerTool();

    await expect(tool.execute("wait", { action: "wait", duration: 0 })).rejects.toThrow(error);

    expect(callGatewayToolMock).toHaveBeenCalledTimes(captures);
    expect(
      callGatewayToolMock.mock.calls.every(
        (call) => (call[2] as ComputerActBody).command === "screen.snapshot",
      ),
    ).toBe(true);
  });

  it.each([
    ["landscape pixels", 1568, 784, "image-pixels", 784, 392],
    ["portrait pixels", 784, 1568, "image-pixels", 392, 784],
    ["rounded axes", 1567, 785, "image-pixels", 783.5, 391.846922],
    ["unscaled pixels", 400, 300, "image-pixels", 200, 150],
    ["global logical points", 1568, 784, "global-logical-points", 600, 300],
    ["provider-defined units", 1568, 784, { unit: "vendor-defined" }, 600, 300],
  ] as const)(
    "binds delivered window image coordinates: %s",
    async (_name, width, height, coordinateSpace, expectedX, expectedY) => {
      const actions: ComputerUseV2ActionName[] = [
        "get_window_state",
        "left_click",
        "left_click_drag",
        "zoom",
      ];
      listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
      const bounds = { x: 1920, y: 300, width: 400, height: 200 };
      const observation = {
        kind: "window",
        base64: createSolidPngBuffer(width, height, { r: 70, g: 125, b: 180 }).toString("base64"),
        format: "png",
        width,
        height,
        observationId: "observation-1",
        elements: [{ elementRef: "element-1", role: "button", label: "Save", bounds }],
      };
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
        const request = body as ComputerActBody;
        if (request.command !== COMPUTER_ACT_COMMAND) {
          return screenshotPayload();
        }
        return request.params?.action === "get_window_state"
          ? { payload: { ok: true, observation, details: { coordinateSpace } } }
          : { payload: { ok: true } };
      });
      const tool = createVisionComputerTool();
      const refs = { windowRef: "window-1", observationId: "observation-1" };
      const result = await tool.execute("observe", {
        action: "get_window_state",
        windowRef: refs.windowRef,
      });
      const image = result.content.find((block) => block.type === "image");
      if (!image) {
        throw new Error("Missing delivered observation image");
      }
      const dimensions = await getImageMetadata(Buffer.from(image.data, "base64"));
      if (!dimensions) {
        throw new Error("Missing delivered image dimensions");
      }
      expect(result.details).toMatchObject({
        result: { observation: { ...dimensions, elements: [{ bounds }] } },
      });
      expect(callGatewayToolMock).toHaveBeenCalledOnce();
      expect(sleepMock).not.toHaveBeenCalledWith(500, expect.anything());
      const coordinate = [Math.floor(dimensions.width / 2), Math.floor(dimensions.height / 2)];
      const startCoordinate = coordinate.map((value) => value / 2);
      for (const action of ["left_click", "left_click_drag", "zoom"] as const) {
        await tool.execute(action, {
          action,
          ...refs,
          ...(action === "zoom"
            ? {
                x1: startCoordinate[0],
                y1: startCoordinate[1],
                x2: coordinate[0],
                y2: coordinate[1],
              }
            : { coordinate, ...(action === "left_click_drag" ? { startCoordinate } : {}) }),
        });
        const sent = readLastComputerActParams();
        expect(sent[action === "zoom" ? "x2" : "x"]).toBeCloseTo(expectedX, 6);
        expect(sent[action === "zoom" ? "y2" : "y"]).toBeCloseTo(expectedY, 6);
        if (action !== "left_click") {
          expect(sent[action === "zoom" ? "x1" : "fromX"]).toBeCloseTo(expectedX / 2, 6);
          expect(sent[action === "zoom" ? "y1" : "fromY"]).toBeCloseTo(expectedY / 2, 6);
        }
      }
    },
  );

  it("rejects pixel input when the observation image is omitted but keeps element refs", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ computerUse: v2Descriptor(["get_window_state", "left_click"]) }),
    ]);
    callGatewayToolMock.mockResolvedValue({
      payload: {
        ok: true,
        observation: {
          kind: "window",
          base64: "invalid!",
          width: 1568,
          height: 784,
          observationId: "observation-1",
        },
        details: { coordinateSpace: "image-pixels" },
      },
    });
    const tool = createVisionComputerTool();
    const refs = { windowRef: "window-1", observationId: "observation-1" };
    const result = await tool.execute("observe", {
      action: "get_window_state",
      windowRef: refs.windowRef,
    });
    expect(result.content.some((block) => block.type === "image")).toBe(false);
    callGatewayToolMock.mockClear();
    await expect(
      tool.execute("pixels", { action: "left_click", ...refs, coordinate: [600, 300] }),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
    await tool.execute("element", { action: "left_click", ...refs, elementRef: "element-1" });
    expect(readLastComputerActParams()).toMatchObject({
      action: "left_click",
      elementRef: "element-1",
    });
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

  it.each(["inspect", "accept", "dismiss"])(
    "captures an after-image only for a dialog mutation: %s",
    async (dialogAction) => {
      listNodesMock.mockResolvedValue([
        macComputerNode({ computerUse: v2Descriptor(["browser_dialog"]) }),
      ]);
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
        (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
          ? { payload: { ok: true, effect: "confirmed" } }
          : screenshotPayload(),
      );
      await createVisionComputerTool().execute("dialog", {
        action: "browser_dialog",
        browserRef: "browser-1",
        pageRef: "page-1",
        dialogAction,
        ...(dialogAction === "inspect" ? {} : { dialogRef: "dialog-1" }),
      });
      expect(
        callGatewayToolMock.mock.calls.map((call) => (call[2] as ComputerActBody).command),
      ).toEqual(
        dialogAction === "inspect"
          ? [COMPUTER_ACT_COMMAND]
          : [COMPUTER_ACT_COMMAND, "screen.snapshot"],
      );
    },
  );

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

import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import {
  driver,
  execution,
  invalidMacOsEndpoints,
  macOsEndpoint,
  result,
} from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import {
  ClickButton,
  EscalationReason,
  ScrollDirection,
  type CuaToolResult,
} from "./driver-client.js";

describe("cua-computer provider", () => {
  it("settles the native driver during node preparation without opening a computer execution", async () => {
    const { session, getDesktopState } = driver();
    const ready = createDeferred<void>();
    let available = false;
    session.isAvailable = () => available;
    session.prepareAvailability = async () => {
      await ready.promise;
      available = true;
    };
    const provider = createCuaComputerProvider({ platform: "linux", driver: session });
    const preparing = provider.prepare?.({ config: {}, env: {} });
    expect(provider.isAvailable()).toBe(false);
    ready.resolve();
    await preparing;
    expect(provider.isAvailable()).toBe(true);
    expect(getDesktopState).not.toHaveBeenCalled();
  });

  it("advertises the implemented Linux v2 capability", () => {
    const { session } = driver();
    const descriptor = createCuaComputerProvider({
      platform: "linux",
      driver: session,
    }).capabilities();
    expect(descriptor).toEqual({
      contractVersion: 2,
      provider: {
        id: "cua-computer",
        label: "CUA Computer",
        generation: "cua-computer-v2:execution-1",
      },
      actions: [
        "screenshot",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "mouse_move",
        "left_click_drag",
        "left_mouse_down",
        "left_mouse_up",
        "scroll",
        "type",
        "key",
        "list_apps",
        "list_windows",
        "get_accessibility_tree",
        "get_cursor_position",
        "get_window_state",
        "launch_app",
        "kill_app",
        "bring_to_front",
        "set_value",
        "zoom",
        "get_browser_state",
        "browser_prepare",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_dialog",
        "browser_set_input_files",
        "browser_download",
        "browser_pointer",
        "escalate_scope",
        "get_recording_state",
        "start_recording",
        "stop_recording",
        "replay_trajectory",
        "invoke_menu",
      ],
      targets: ["screen", "window", "element", "browser"],
      deliveryModes: ["background", "foreground"],
      observations: ["image", "accessibility", "browser"],
      features: { recording: true, agentCursor: false, multiDisplay: false },
    });
  });

  it("omits Linux-only held-button actions on Windows", () => {
    const { session } = driver();
    const actions = createCuaComputerProvider({ platform: "win32", driver: session }).capabilities()
      .actions;
    expect(actions).not.toContain("left_mouse_down");
    expect(actions).not.toContain("left_mouse_up");
    expect(actions).toContain("get_window_state");
    expect(actions).toEqual(
      expect.arrayContaining([
        "get_recording_state",
        "start_recording",
        "stop_recording",
        "replay_trajectory",
      ]),
    );
  });

  it("advertises the macOS mapping only with a valid atomic app-provided endpoint", () => {
    const { session } = driver();
    const endpoint = macOsEndpoint();
    const provider = createCuaComputerProvider({
      platform: "darwin",
      env: endpoint,
      driver: session,
    });

    expect(provider.isAvailable()).toBe(true);
    expect(provider.capabilities().actions).toContain("get_window_state");
    expect(provider.capabilities().actions).not.toContain("left_mouse_down");
    expect(provider.capabilities().features).toEqual({
      recording: true,
      agentCursor: false,
      multiDisplay: false,
    });

    const createDriver = vi.fn(() => session);
    expect(
      createCuaComputerProvider({
        platform: "darwin",
        env: endpoint,
        createDriver,
      }).isAvailable(),
    ).toBe(true);
    expect(createDriver).not.toHaveBeenCalled();

    for (const [label, env] of invalidMacOsEndpoints()) {
      expect(
        createCuaComputerProvider({ platform: "darwin", env, driver: session }).isAvailable(),
        label,
      ).toBe(false);
    }
  });

  it("keeps macOS Retina screenshots in native-pixel action coordinates", async () => {
    const retina = driver({
      geometry: {
        platform: "macos",
        display: "primary",
        screenshot_width: 200,
        screenshot_height: 100,
        screen_width: 100,
        screen_height: 50,
        scale_factor: 2,
      },
      screenSize: { width: 100, height: 50, scale_factor: 2 },
    });
    const computer = await createCuaComputerProvider({
      platform: "darwin",
      env: macOsEndpoint(),
      driver: retina.session,
      imageProcessor: {
        encode: vi.fn(async () => ({ data: Buffer.from("png"), width: 100, height: 50 })),
      },
    }).openExecution({ executionId: "123e4567-e89b-42d3-a456-426614174000" });
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };

    await computer.act(
      JSON.stringify({
        action: "left_click",
        displayFrameId: screen.displayFrameId,
        refWidth: screen.width,
        x: 10,
        y: 10,
      }),
    );

    expect(retina.click).toHaveBeenCalledWith(
      { x: 20, y: 20, button: ClickButton.Left, count: 1 },
      undefined,
    );
  });

  it("uses one typed session for snapshot and frame-authorized click", async () => {
    const { session, getDesktopState, getScreenSize, click } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await computer.act(
      JSON.stringify({
        action: "left_click",
        displayFrameId: screen.displayFrameId,
        refWidth: screen.width,
        x: 10,
        y: 20,
      }),
    );
    expect(getDesktopState).toHaveBeenCalledOnce();
    expect(getScreenSize).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledWith(
      {
        x: 10,
        y: 20,
        button: ClickButton.Left,
        count: 1,
      },
      undefined,
    );
  });

  it("maps scroll and key through typed SDK enums", async () => {
    const { session, typeText, pressKey } = driver();
    const computer = await execution(session);
    await computer.act('{"action":"type","text":"hello"}');
    await computer.act('{"action":"key","keys":"ctrl+enter"}');
    expect(typeText).toHaveBeenCalledWith("hello", undefined);
    expect(pressKey).toHaveBeenCalledWith({ key: "enter", modifiers: ["ctrl"] }, undefined);
    expect(ScrollDirection.Down).toBeTypeOf("number");
  });

  it("maps all remaining projected desktop actions through direct SDK methods", async () => {
    const { session, scroll, moveCursor, drag } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    const frame = { displayFrameId: screen.displayFrameId, refWidth: screen.width };

    await computer.act(
      JSON.stringify({
        action: "scroll",
        ...frame,
        x: 10,
        y: 20,
        scrollDirection: "down",
        scrollAmount: 4,
      }),
    );
    await computer.act(JSON.stringify({ action: "mouse_move", ...frame, x: 11, y: 21 }));
    await computer.act(
      JSON.stringify({
        action: "left_click_drag",
        ...frame,
        fromX: 12,
        fromY: 22,
        x: 13,
        y: 23,
        durationMs: 500,
      }),
    );

    expect(scroll).toHaveBeenCalledWith(
      { x: 10, y: 20, direction: ScrollDirection.Down, amount: 4n },
      undefined,
    );
    expect(moveCursor).toHaveBeenCalledWith({ x: 11, y: 21 }, undefined);
    expect(drag).toHaveBeenCalledWith(
      { fromX: 12, fromY: 22, toX: 13, toY: 23, durationMs: 500n },
      undefined,
    );
  });

  it("turns a direct SDK refusal into a typed computer error", async () => {
    const { session, click } = driver();
    click.mockResolvedValueOnce({
      ...result({}),
      isError: true,
      errorCode: "desktop_unavailable",
      text: "desktop input is unavailable",
    });
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };
    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_REFUSED_desktop_unavailable");
  });

  it("rejects a mismatched reference width before desktop input", async () => {
    const { session, click } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      displayFrameId: string;
      width: number;
    };

    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width + 1,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME: the coordinate reference width changed");
    expect(click).not.toHaveBeenCalled();
  });

  it("rejects a forged frame before desktop input", async () => {
    const { session, click } = driver();
    const computer = await execution(session);
    const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}')) as {
      width: number;
    };

    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          displayFrameId: "cua:v1:forged",
          refWidth: screen.width,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_FRAME");
    expect(click).not.toHaveBeenCalled();
  });

  it("lazily owns one session and closes it when node-host availability stops", async () => {
    const { session, dispose } = driver();
    const createDriver = vi.fn(() => session);
    const clearInterval = vi.fn();
    const provider = createCuaComputerProvider({
      platform: "linux",
      createDriver,
      imageProcessor: {
        encode: vi.fn(async () => ({ data: Buffer.from("jpeg"), width: 100, height: 50 })),
      },
      setInterval: vi.fn(() => Object.assign(1, { unref: vi.fn() })) as never,
      clearInterval: clearInterval as never,
    });
    expect(createDriver).not.toHaveBeenCalled();

    const computer = await provider.openExecution({
      executionId: "123e4567-e89b-42d3-a456-426614174000",
    });
    await computer.snapshot('{"format":"png","maxWidth":100}');
    expect(createDriver).toHaveBeenCalledOnce();

    const stop = provider.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    stop?.();
    await Promise.resolve();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("passes node invocation cancellation to the direct SDK", async () => {
    const { session, getDesktopState } = driver();
    const computer = await execution(session);
    const signal = AbortSignal.abort();
    await computer.snapshot('{"format":"png","maxWidth":100}', signal);
    expect(getDesktopState).toHaveBeenCalledWith(signal);
  });

  it("mints opaque window and element references and maps background evidence", async () => {
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name) => {
      switch (name) {
        case "list_windows":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
        case "get_window_state":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
        case "click":
          return cuaToolResult(
            {},
            {
              action:
                CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
            },
          );
        default:
          return cuaToolResult({});
      }
    });
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    expect(windowRef).toMatch(/^cua:v2:window:/);

    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ) as {
      observation: {
        observationId: string;
        elements: Array<{ elementRef: string }>;
      };
    };
    const { observationId } = observed.observation;
    const elementRef = observed.observation.elements[0]!.elementRef;
    expect(observationId).toMatch(/^cua:v2:observation:/);
    expect(elementRef).toMatch(/^cua:v2:element:/);

    const clicked = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "left_click",
          windowRef,
          elementRef,
          observationId,
          deliveryMode: "background",
        }),
      ),
    ) as { effect: string; details: Record<string, unknown> };
    expect(clicked).toMatchObject({
      ok: true,
      effect: "confirmed",
      details: {
        route: "accessibility",
        deliveryMode: "background",
        deliveredCount: 1,
        evidence: ["value_readback"],
      },
    });
    expect(callTool).toHaveBeenLastCalledWith(
      "click",
      {
        pid: 4242,
        window_id: 99,
        element_token: "native-element-token-7",
        button: "left",
        count: 1,
        delivery_mode: "background",
      },
      undefined,
    );
  });

  it("rejects forged window, observation, and element refs before native resolution", async () => {
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_window_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
      }
      return cuaToolResult({});
    });
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ) as {
      observation: { observationId: string; elements: Array<{ elementRef: string }> };
    };
    const callsBeforeHostileRefs = callTool.mock.calls.length;

    for (const input of [
      { action: "get_window_state", windowRef: "/tmp/native-window" },
      {
        action: "left_click",
        windowRef,
        observationId: "/tmp/native-observation",
        elementRef: observed.observation.elements[0]!.elementRef,
      },
      {
        action: "left_click",
        windowRef,
        observationId: observed.observation.observationId,
        elementRef: "../native-element",
      },
    ]) {
      await expect(computer.act(JSON.stringify(input))).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
    }
    expect(callTool).toHaveBeenCalledTimes(callsBeforeHostileRefs);
  });

  it("maps window pixels, app lifecycle, menu, zoom, and escalation tools", async () => {
    const { session, callTool, escalateScope } = driver();
    callTool.mockImplementation(async (name) => {
      switch (name) {
        case "list_apps":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listApps);
        case "list_windows":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
        case "get_window_state":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
        case "zoom":
          return cuaToolResult({ screenshot_width: 300, screenshot_height: 200 }, { image: true });
        default:
          return cuaToolResult(
            {},
            {
              action:
                CUA_DRIVER_CONTRACT_FIXTURES.suspectedNoopAction as unknown as CuaToolResult["action"],
            },
          );
      }
    });
    const computer = await execution(session);
    const apps = JSON.parse(await computer.act('{"action":"list_apps"}')) as {
      details: { apps: Array<{ app: string }> };
    };
    const app = apps.details.apps[0]!.app;
    const windows = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = windows.details.windows[0]!.windowRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ) as { observation: { observationId: string } };

    await computer.act(JSON.stringify({ action: "launch_app", app }));
    await computer.act(JSON.stringify({ action: "kill_app", app }));
    await computer.act(
      JSON.stringify({ action: "invoke_menu", windowRef, path: ["File", "Save"] }),
    );
    const zoomed = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "zoom",
          windowRef,
          observationId: observed.observation.observationId,
          x1: 0,
          y1: 0,
          x2: 100,
          y2: 100,
        }),
      ),
    ) as { observation: { observationId: string } };
    expect(zoomed.observation.observationId).not.toBe(observed.observation.observationId);
    await computer.act(
      JSON.stringify({ action: "escalate_scope", reason: "background_delivery_failed" }),
    );

    expect(callTool).toHaveBeenCalledWith(
      "launch_app",
      { launch_path: "/usr/bin/editor" },
      undefined,
    );
    expect(callTool).toHaveBeenCalledWith("kill_app", { pid: 4242 }, undefined);
    expect(callTool).toHaveBeenCalledWith(
      "invoke_menu",
      { pid: 4242, window_id: 99, path: ["File", "Save"] },
      undefined,
    );
    expect(escalateScope).toHaveBeenCalledWith(
      EscalationReason.BackgroundDeliveryFailed,
      undefined,
    );
  });

  it("rejects model-supplied app paths and commands before driver dispatch", async () => {
    const { session, callTool } = driver();
    const computer = await execution(session);

    for (const app of ["/usr/bin/open", "../outside", "sh -c 'touch /tmp/owned'"]) {
      await expect(computer.act(JSON.stringify({ action: "launch_app", app }))).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
    }

    expect(callTool).not.toHaveBeenCalled();
  });

  it("maps the complete Linux window pointer and keyboard family", async () => {
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_window_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
      }
      return cuaToolResult(
        {},
        {
          action:
            CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
        },
      );
    });
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ) as {
      observation: { observationId: string; elements: Array<{ elementRef: string }> };
    };
    const observationId = observed.observation.observationId;
    const elementRef = observed.observation.elements[0]!.elementRef;
    const pixelTarget = { windowRef, observationId, x: 20, y: 30 };
    const cases = [
      ["right_click", "click", { button: "right", count: 1 }],
      ["middle_click", "click", { button: "middle", count: 1 }],
      ["double_click", "click", { button: "left", count: 2 }],
      ["triple_click", "click", { button: "left", count: 3 }],
      ["left_click_drag", "drag", { from_x: 10, from_y: 15, to_x: 20, to_y: 30, duration_ms: 250 }],
      ["left_mouse_down", "mouse_button_down", { x: 20, y: 30, button: "left" }],
      ["left_mouse_up", "mouse_button_up", { x: 20, y: 30 }],
      ["scroll", "scroll", { direction: "down", by: "line", amount: 4 }],
      ["type", "type_text", { text: "hello", element_token: "native-element-token-7" }],
      ["key", "press_key", { key: "enter", modifiers: ["ctrl"] }],
    ] as const;

    for (const [action, tool, expected] of cases) {
      const actionInput: Record<string, unknown> = {
        action,
        ...pixelTarget,
        deliveryMode: action.startsWith("left_mouse_") ? "background" : "foreground",
      };
      if (action === "left_click_drag") {
        actionInput.fromX = 10;
        actionInput.fromY = 15;
        actionInput.durationMs = 250;
      } else if (action === "scroll") {
        actionInput.scrollDirection = "down";
        actionInput.scrollAmount = 4;
      } else if (action === "type") {
        actionInput.elementRef = elementRef;
        actionInput.text = "hello";
        delete actionInput.x;
        delete actionInput.y;
      } else if (action === "key") {
        actionInput.keys = "ctrl+enter";
        delete actionInput.x;
        delete actionInput.y;
      }
      await computer.act(JSON.stringify(actionInput));
      expect(callTool).toHaveBeenCalledWith(
        tool,
        expect.objectContaining({ pid: 4242, window_id: 99, ...expected }),
        undefined,
      );
    }
  });

  it("maps remaining discovery, window lifecycle, and semantic actions", async () => {
    const { session, callTool, getCursorPosition } = driver();
    callTool.mockImplementation(async (name) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_window_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
      }
      if (name === "get_accessibility_tree") {
        return cuaToolResult({
          processes: [{ pid: 4242, name: "Editor" }],
          windows: CUA_DRIVER_CONTRACT_FIXTURES.listWindows.windows,
        });
      }
      return cuaToolResult(
        {},
        {
          action:
            CUA_DRIVER_CONTRACT_FIXTURES.confirmedBackgroundAction as unknown as CuaToolResult["action"],
        },
      );
    });
    getCursorPosition.mockResolvedValue(cuaToolResult({ x: 11, y: 12, source: "x11" }));
    const computer = await execution(session);
    const tree = JSON.parse(await computer.act('{"action":"get_accessibility_tree"}')) as {
      details: { windows: unknown[]; processes: unknown[] };
    };
    expect(tree.details.windows).toHaveLength(1);
    expect(tree.details.processes).toHaveLength(1);
    await expect(computer.act('{"action":"get_cursor_position"}')).resolves.toContain('"x":11');
    expect(getCursorPosition).toHaveBeenCalledWith(undefined);

    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ) as {
      observation: { observationId: string; elements: Array<{ elementRef: string }> };
    };
    await computer.act(JSON.stringify({ action: "bring_to_front", windowRef }));
    await computer.act(
      JSON.stringify({
        action: "set_value",
        windowRef,
        observationId: observed.observation.observationId,
        elementRef: observed.observation.elements[0]!.elementRef,
        value: "new",
        deliveryMode: "background",
      }),
    );
    expect(callTool).toHaveBeenCalledWith(
      "bring_to_front",
      { pid: 4242, window_id: 99 },
      undefined,
    );
    expect(callTool).toHaveBeenCalledWith(
      "set_value",
      {
        pid: 4242,
        window_id: 99,
        element_token: "native-element-token-7",
        value: "new",
      },
      undefined,
    );
  });

  it("maps window delivery refusals to the closed computer error prefix", async () => {
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_window_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
      }
      return cuaToolResult(
        { code: "background_occluded" },
        {
          isError: true,
          errorCode: "background_occluded",
          text: "target is occluded",
        },
      );
    });
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ) as { observation: { observationId: string } };
    await expect(
      computer.act(
        JSON.stringify({
          action: "left_click",
          windowRef,
          observationId: observed.observation.observationId,
          x: 10,
          y: 20,
        }),
      ),
    ).rejects.toThrow("COMPUTER_REFUSED_background_occluded");
  });

  it("invalidates observation references when the driver generation rotates", async () => {
    const { session, callTool, setGeneration } = driver();
    callTool.mockImplementation(async (name) =>
      name === "list_windows"
        ? cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows)
        : cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true }),
    );
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;
    setGeneration("execution-2");

    await expect(
      computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

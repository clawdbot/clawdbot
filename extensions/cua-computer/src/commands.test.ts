import { describe, expect, it, vi } from "vitest";
import { createCuaComputerProvider } from "./commands.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import {
  ClickButton,
  EscalationReason,
  ScrollDirection,
  type CuaDriverSession,
  type CuaToolResult,
} from "./driver-client.js";

const geometry = {
  platform: "linux",
  display: "primary",
  screenshot_width: 100,
  screenshot_height: 50,
  screen_width: 100,
  screen_height: 50,
  scale_factor: 1,
};

const CUA_DRIVER_ENDPOINT_ENV = "OPENCLAW_CUA_DRIVER_ENDPOINT";

function macOsEndpoint(overrides: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  return {
    [CUA_DRIVER_ENDPOINT_ENV]: JSON.stringify({
      v: 1,
      socketPath: "/tmp/openclaw-cua-test/driver.sock",
      binaryPath: process.execPath,
      ...overrides,
    }),
  };
}

function result(structured: Record<string, unknown>, image = false): CuaToolResult {
  return {
    text: "ok",
    images: image
      ? [{ mimeType: "image/png", dataBase64: Buffer.from("png").toString("base64") }]
      : [],
    structuredJson: JSON.stringify(structured),
    isError: false,
    degraded: false,
    rawJson: "{}",
  };
}

function driver(
  options: {
    geometry?: typeof geometry;
    screenSize?: { width: number; height: number; scale_factor: number };
  } = {},
) {
  let generation = "execution-1";
  const activeGeometry = options.geometry ?? geometry;
  const getDesktopState = vi.fn(async () => result(activeGeometry, true));
  const getScreenSize = vi.fn(async () =>
    result(
      options.screenSize ?? {
        width: activeGeometry.screen_width,
        height: activeGeometry.screen_height,
        scale_factor: activeGeometry.scale_factor,
      },
    ),
  );
  const click = vi.fn(async () => result({}));
  const drag = vi.fn(async () => result({}));
  const moveCursor = vi.fn(async () => result({}));
  const scroll = vi.fn(async () => result({}));
  const typeText = vi.fn(async () => result({}));
  const pressKey = vi.fn(async () => result({}));
  const callTool = vi.fn<CuaDriverSession["callTool"]>(async () => result({}));
  const escalateScope = vi.fn(async () => ({
    session: "openclaw-test",
    captureScope: 2,
    effectiveScope: 1,
    desktopUnlocked: true,
  }));
  const dispose = vi.fn(async () => {});
  const session: CuaDriverSession = {
    get generation() {
      return generation;
    },
    isAvailable: () => true,
    resetAvailabilityCache: () => {},
    callTool,
    escalateScope,
    getDesktopState,
    getScreenSize,
    click,
    drag,
    moveCursor,
    scroll,
    typeText,
    pressKey,
    dispose,
  };
  return {
    session,
    getDesktopState,
    getScreenSize,
    click,
    drag,
    moveCursor,
    scroll,
    callTool,
    escalateScope,
    dispose,
    typeText,
    pressKey,
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}

async function execution(session: CuaDriverSession) {
  return await createCuaComputerProvider({
    platform: "linux",
    driver: session,
    imageProcessor: {
      encode: vi.fn(async () => ({ data: Buffer.from("jpeg"), width: 100, height: 50 })),
    },
  }).openExecution({});
}

describe("cua-computer provider", () => {
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
        "invoke_menu",
      ],
      targets: ["screen", "window", "element", "browser"],
      deliveryModes: ["background", "foreground"],
      observations: ["image", "accessibility", "browser"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    });
  });

  it("omits Linux-only held-button actions on Windows", () => {
    const { session } = driver();
    const actions = createCuaComputerProvider({ platform: "win32", driver: session }).capabilities()
      .actions;
    expect(actions).not.toContain("left_mouse_down");
    expect(actions).not.toContain("left_mouse_up");
    expect(actions).toContain("get_window_state");
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
      recording: false,
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

    const invalidEndpoints: Array<[string, NodeJS.ProcessEnv]> = [
      ["missing", {}],
      ["malformed JSON", { [CUA_DRIVER_ENDPOINT_ENV]: "{" }],
      [
        "partial",
        {
          [CUA_DRIVER_ENDPOINT_ENV]: JSON.stringify({
            v: 1,
            socketPath: "/tmp/openclaw-cua-test/driver.sock",
          }),
        },
      ],
      ["unsupported version", macOsEndpoint({ v: 2 })],
      ["extra field", macOsEndpoint({ extra: true })],
      ["relative socket", macOsEndpoint({ socketPath: "relative.sock" })],
      ["relative binary", macOsEndpoint({ binaryPath: "cua-driver" })],
      ["nul socket", macOsEndpoint({ socketPath: "/tmp/cua\0.sock" })],
      ["missing binary", macOsEndpoint({ binaryPath: "/missing/cua-driver" })],
      ["oversized", macOsEndpoint({ socketPath: `/${"x".repeat(4_096)}` })],
    ];
    for (const [label, env] of invalidEndpoints) {
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
    }).openExecution({});
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

    const computer = await provider.openExecution({});
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
    const { session, callTool } = driver();
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
      if (name === "get_cursor_position") {
        return cuaToolResult({ x: 11, y: 12, source: "x11" });
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
    const tree = JSON.parse(await computer.act('{"action":"get_accessibility_tree"}')) as {
      details: { windows: unknown[]; processes: unknown[] };
    };
    expect(tree.details.windows).toHaveLength(1);
    expect(tree.details.processes).toHaveLength(1);
    await expect(computer.act('{"action":"get_cursor_position"}')).resolves.toContain('"x":11');

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

  it("maps every browser action to the pinned driver tool contract", async () => {
    const { session, callTool } = driver();
    callTool.mockImplementation(async (name, args) => {
      switch (name) {
        case "list_windows":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
        case "get_browser_state":
          return cuaToolResult(
            "target_id" in args
              ? CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot
              : CUA_DRIVER_CONTRACT_FIXTURES.browserBinding,
            { image: "target_id" in args },
          );
        case "browser_prepare":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserPrepare);
        case "browser_navigate":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserNavigate);
        case "browser_dialog":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserDialog);
        case "browser_set_input_files":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserFiles);
        case "browser_download":
          return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserDownload);
        case "browser_click":
        case "browser_type":
        case "browser_pointer":
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

    await computer.act(
      JSON.stringify({
        action: "browser_prepare",
        windowRef,
        profile: "isolated_named",
        profileName: "openclaw-test",
      }),
    );
    const boundJson = await computer.act(
      JSON.stringify({ action: "get_browser_state", windowRef }),
    );
    expect(boundJson).not.toContain("native-browser-target-1");
    expect(boundJson).not.toContain("native-page-1");
    const bound = JSON.parse(boundJson) as {
      details: { browserRef: string; pages: Array<{ pageRef: string }> };
    };
    expect(bound.details.browserRef).toMatch(/^cua:v2:browser:/);
    expect(bound.details.pages[0]!.pageRef).toMatch(/^cua:v2:page:/);
    const browserRef = bound.details.browserRef;
    const pageRef = bound.details.pages[0]!.pageRef;

    const observedJson = await computer.act(
      JSON.stringify({ action: "get_browser_state", browserRef, pageRef }),
    );
    expect(observedJson).not.toContain("p7:0");
    const observed = JSON.parse(observedJson) as {
      observation: { kind: string; observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    expect(observed.observation.kind).toBe("browser");
    const observationId = observed.observation.observationId;
    const [firstElement, secondElement] = observed.details.elements.map(
      (element) => element.elementRef,
    );
    expect(firstElement).toMatch(/^cua:v2:element:/);

    await computer.act(
      JSON.stringify({
        action: "browser_click",
        browserRef,
        pageRef,
        observationId,
        elementRef: firstElement,
        inputRoute: "dom_event",
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_type",
        browserRef,
        pageRef,
        observationId,
        elementRef: secondElement,
        text: "hello",
        mode: "keystrokes",
        replace: true,
      }),
    );
    const dialog = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "browser_dialog",
          browserRef,
          pageRef,
          dialogAction: "inspect",
        }),
      ),
    ) as { details: { dialogRef: string } };
    expect(dialog.details.dialogRef).toMatch(/^cua:v2:dialog:/);
    await computer.act(
      JSON.stringify({
        action: "browser_set_input_files",
        browserRef,
        pageRef,
        observationId,
        elementRef: secondElement,
        files: ["/tmp/input.txt"],
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_download",
        browserRef,
        pageRef,
        observationId,
        elementRef: firstElement,
        destinationRoot: "/tmp/downloads",
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_pointer",
        browserRef,
        pageRef,
        observationId,
        pointerAction: "drag",
        inputRoute: "dom_event",
        elementRef: firstElement,
        destinationElementRef: secondElement,
      }),
    );
    await computer.act(
      JSON.stringify({
        action: "browser_navigate",
        browserRef,
        pageRef,
        url: "https://example.com/next",
      }),
    );

    expect(callTool.mock.calls).toEqual([
      ["list_windows", {}, undefined],
      [
        "browser_prepare",
        {
          pid: 4242,
          allow_launch: true,
          profile: { mode: "isolated_named", name: "openclaw-test" },
        },
        undefined,
      ],
      ["get_browser_state", { pid: 4242, window_id: 99 }, undefined],
      [
        "get_browser_state",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          snapshot_format: "dom_refs_v1",
          include_screenshot: true,
        },
        undefined,
      ],
      [
        "browser_click",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:0",
          input_route: "dom_event",
        },
        undefined,
      ],
      [
        "browser_type",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:1",
          text: "hello",
          mode: "keystrokes",
          replace: true,
        },
        undefined,
      ],
      [
        "browser_dialog",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          action: "inspect",
        },
        undefined,
      ],
      [
        "browser_set_input_files",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:1",
          files: ["/tmp/input.txt"],
        },
        undefined,
      ],
      [
        "browser_download",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          ref: "p7:0",
          destination_root: "/tmp/downloads",
        },
        undefined,
      ],
      [
        "browser_pointer",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          action: "drag",
          input_route: "dom_event",
          ref: "p7:0",
          destination_ref: "p7:1",
        },
        undefined,
      ],
      [
        "browser_navigate",
        {
          target_id: "native-browser-target-1",
          tab_id: "native-page-1",
          url: "https://example.com/next",
        },
        undefined,
      ],
    ]);
  });

  it("invalidates browser capabilities across navigation, generation, and execution", async () => {
    const first = driver();
    first.callTool.mockImplementation(async (name, args) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_browser_state") {
        return cuaToolResult(
          "target_id" in args
            ? CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot
            : CUA_DRIVER_CONTRACT_FIXTURES.browserBinding,
        );
      }
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserNavigate);
    });
    const computer = await execution(first.session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const bound = JSON.parse(
      await computer.act(
        JSON.stringify({
          action: "get_browser_state",
          windowRef: listed.details.windows[0]!.windowRef,
        }),
      ),
    ) as { details: { browserRef: string; pages: Array<{ pageRef: string }> } };
    const browserRef = bound.details.browserRef;
    const pageRef = bound.details.pages[0]!.pageRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ) as {
      observation: { observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    const staleAction = {
      action: "browser_click",
      browserRef,
      pageRef,
      observationId: observed.observation.observationId,
      elementRef: observed.details.elements[0]!.elementRef,
    };

    await computer.act(
      JSON.stringify({ action: "browser_navigate", browserRef, pageRef, url: "about:blank" }),
    );
    await expect(computer.act(JSON.stringify(staleAction))).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );

    first.setGeneration("execution-2");
    await expect(
      computer.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");

    const second = await execution(first.session);
    await expect(
      second.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
  });

  it("keeps existing-profile browser attachment outside the accepted contract", async () => {
    const { session, callTool } = driver();
    callTool.mockResolvedValueOnce(cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows));
    const computer = await execution(session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const windowRef = listed.details.windows[0]!.windowRef;

    await expect(
      computer.act(
        JSON.stringify({
          action: "browser_prepare",
          windowRef,
          profile: "existing_profile",
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    await expect(
      computer.act(
        JSON.stringify({
          action: "browser_prepare",
          windowRef,
          strategy: { kind: "existing_profile" },
        }),
      ),
    ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rechecks browser generation and structured stale refusals after driver calls", async () => {
    const active = driver();
    let staleOnSnapshot = true;
    active.callTool.mockImplementation(async (name, args) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_browser_state" && !("target_id" in args)) {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserBinding);
      }
      if (name === "get_browser_state" && staleOnSnapshot) {
        active.setGeneration("execution-2");
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot);
      }
      if (name === "get_browser_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot);
      }
      return cuaToolResult({
        status: "refused",
        refusal: { code: "browser_ref_stale", message: "page changed" },
      });
    });
    const computer = await execution(active.session);
    const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    const bind = async () =>
      JSON.parse(
        await computer.act(
          JSON.stringify({
            action: "get_browser_state",
            windowRef: listed.details.windows[0]!.windowRef,
          }),
        ),
      ) as { details: { browserRef: string; pages: Array<{ pageRef: string }> } };
    const firstBinding = await bind();
    await expect(
      computer.act(
        JSON.stringify({
          action: "get_browser_state",
          browserRef: firstBinding.details.browserRef,
          pageRef: firstBinding.details.pages[0]!.pageRef,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");

    staleOnSnapshot = false;
    const refreshedWindows = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
      details: { windows: Array<{ windowRef: string }> };
    };
    listed.details.windows = refreshedWindows.details.windows;
    const secondBinding = await bind();
    const browserRef = secondBinding.details.browserRef;
    const pageRef = secondBinding.details.pages[0]!.pageRef;
    const observed = JSON.parse(
      await computer.act(JSON.stringify({ action: "get_browser_state", browserRef, pageRef })),
    ) as {
      observation: { observationId: string };
      details: { elements: Array<{ elementRef: string }> };
    };
    await expect(
      computer.act(
        JSON.stringify({
          action: "browser_click",
          browserRef,
          pageRef,
          observationId: observed.observation.observationId,
          elementRef: observed.details.elements[0]!.elementRef,
        }),
      ),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
  });
});
/* oxlint-disable max-lines -- The pinned driver contract table records every browser tool shape beside the provider lifecycle regressions it exercises. */

/**
 * Frozen CUA Driver 0.14.1 desktop contract fixtures used by the CUA fulfiller tests.
 *
 * Evidence: cua-driver-rs-v0.14.1 (41ae29b44b49b68c6e01c934fffbbe74d22e26fb)
 * and @trycua/cua-driver@0.14.1. The SDK declarations name these methods with
 * camelCase and encode DesktopScope.Desktop as 0; MCP uses the snake_case tool
 * names and the "desktop" scope string below.
 */
export const CUA_DRIVER_0141_CONTRACT = {
  version: "0.14.1",
  releaseTag: "cua-driver-rs-v0.14.1",
  releaseCommit: "41ae29b44b49b68c6e01c934fffbbe74d22e26fb",
  npmIntegrity:
    "sha512-/o16k+vcTbdqwmvQqgFCKzrYksSQHz282qO8RkpD67GQoY4Vp3pyDndQexRJ8AbzNQpUt1bIXSAAaFBaMad6rg==",
  serverName: "cua-driver",
  capabilityVersion: "1",
  schemaVersion: "1",
} as const;

export const CUA_DRIVER_0141_SDK_DESKTOP_SCOPE = 0 as const;

export const CUA_DRIVER_0141_SDK_FIXTURES = {
  getDesktopState: {},
  getScreenSize: {},
  getCursorPosition: {},
  click: {
    x: 960,
    y: 540,
    scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE,
    button: 0,
    count: 1,
  },
  drag: {
    fromX: 100,
    fromY: 200,
    toX: 960,
    toY: 540,
    scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE,
    durationMs: 500n,
  },
  moveCursor: { x: 960, y: 540, scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE },
  scroll: {
    x: 960,
    y: 540,
    direction: 1,
    scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE,
    by: 0,
    amount: 3n,
  },
  typeText: { text: "hello", scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE },
  pressKey: {
    key: "enter",
    scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE,
    modifiers: ["shift"],
  },
  hotkey: { keys: ["ctrl", "c"], scope: CUA_DRIVER_0141_SDK_DESKTOP_SCOPE },
} as const;

export const CUA_DRIVER_0141_MCP_FIXTURES = {
  serverInfo: {
    name: CUA_DRIVER_0141_CONTRACT.serverName,
    version: CUA_DRIVER_0141_CONTRACT.version,
  },
  toolsList: {
    capability_version: CUA_DRIVER_0141_CONTRACT.capabilityVersion,
    schema_version: CUA_DRIVER_0141_CONTRACT.schemaVersion,
  },
  desktopState: {
    platform: "linux",
    display: "primary",
    screenshot_width: 3840,
    screenshot_height: 2160,
    screen_width: 3840,
    screen_height: 2160,
    scale_factor: 1,
    screenshot_mime_type: "image/png",
  },
  screenSize: { width: 3840, height: 2160, scale_factor: 1 },
} as const;

export const CUA_DRIVER_0141_FAILURE_FIXTURES = {
  invalidArguments: {
    isError: true,
    content: [{ type: "text", text: "click: invalid arguments: missing field `x`" }],
    structuredContent: { code: "invalid_arguments", tool: "click" },
  },
  refusal: {
    isError: true,
    content: [{ type: "text", text: "desktop input is unavailable" }],
    structuredContent: { code: "desktop_unavailable" },
  },
} as const;

export const CUA_DRIVER_0141_GENERATION_FIXTURE = {
  initial: "connection-e8dcf30c",
  reconnected: "connection-7857c486",
} as const;

export const CUA_DRIVER_0141_DESKTOP_OPERATIONS = [
  "get_desktop_state",
  "get_screen_size",
  "get_cursor_position",
  "click",
  "drag",
  "move_cursor",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
] as const;

type CuaDriver0141DesktopOperation = (typeof CUA_DRIVER_0141_DESKTOP_OPERATIONS)[number];
type CuaDriver0141SdkMethod = keyof typeof CUA_DRIVER_0141_SDK_FIXTURES;

export const CUA_DRIVER_0141_COMPUTER_ACT_PARITY = [
  {
    operation: "get_desktop_state",
    sdkMethod: "getDesktopState",
    disposition: "screen.snapshot",
    computerActions: ["screenshot"],
  },
  {
    operation: "get_screen_size",
    sdkMethod: "getScreenSize",
    disposition: "frame verification",
    computerActions: [],
  },
  {
    operation: "get_cursor_position",
    sdkMethod: "getCursorPosition",
    disposition: "not projected",
    computerActions: [],
  },
  {
    operation: "click",
    sdkMethod: "click",
    disposition: "computer.act",
    computerActions: ["left_click", "right_click", "middle_click", "double_click", "triple_click"],
  },
  {
    operation: "drag",
    sdkMethod: "drag",
    disposition: "computer.act",
    computerActions: ["left_click_drag"],
  },
  {
    operation: "move_cursor",
    sdkMethod: "moveCursor",
    disposition: "computer.act",
    computerActions: ["mouse_move"],
  },
  {
    operation: "scroll",
    sdkMethod: "scroll",
    disposition: "computer.act",
    computerActions: ["scroll"],
  },
  {
    operation: "type_text",
    sdkMethod: "typeText",
    disposition: "computer.act",
    computerActions: ["type"],
  },
  {
    operation: "press_key",
    sdkMethod: "pressKey",
    disposition: "computer.act",
    computerActions: ["key"],
  },
  {
    operation: "hotkey",
    sdkMethod: "hotkey",
    disposition: "not projected",
    computerActions: [],
  },
] as const satisfies readonly {
  operation: CuaDriver0141DesktopOperation;
  sdkMethod: CuaDriver0141SdkMethod;
  disposition: "screen.snapshot" | "frame verification" | "computer.act" | "not projected";
  computerActions: readonly string[];
}[];

export const COMPUTER_ACT_ACTION_FIXTURES = [
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
  "hold_key",
  "wait",
] as const;

export const CUA_DRIVER_0141_UNSUPPORTED_COMPUTER_ACT_ACTIONS = [
  "hold_key",
  "left_mouse_down",
  "left_mouse_up",
] as const;

export const CUA_DRIVER_0141_CORE_LOCAL_COMPUTER_ACT_ACTIONS = ["wait"] as const;

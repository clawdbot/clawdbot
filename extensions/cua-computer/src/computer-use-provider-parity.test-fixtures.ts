/**
 * Frozen design inputs for the computer.act v2 provider contract.
 *
 * CUA evidence comes from the immutable cua-driver-rs-v0.19.3 tag. The runtime
 * registries are larger than the generated portable contract manifest: the
 * manifest has 23 tools, while the platform registries expose 53 on macOS, 54
 * on Windows, and 57 on Linux (58 unique names across all three platforms).
 * Peekaboo evidence comes from its canonical MCPToolCatalog at the pinned
 * source commit below; that catalog contains 26 tools, not the previously
 * documented 25.
 */

export const COMPUTER_USE_V2_ACTION_NAMES = [
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
] as const;

export type ComputerUseV2ActionName = (typeof COMPUTER_USE_V2_ACTION_NAMES)[number];
export type ComputerUseProviderId = "cua" | "peekaboo";
export type ComputerUseDeliveryMode = "background" | "foreground";

export const CUA_PROVIDER_PARITY_SOURCE = {
  version: "0.19.3",
  releaseTag: "cua-driver-rs-v0.19.3",
  releaseCommit: "a1672e7b11951275ecfba3384264d4530185d0db",
  contractManifestVersion: "0.6.0",
  contractManifestToolCount: 23,
  registryToolCounts: {
    macos: 53,
    windows: 54,
    linux: 57,
    union: 58,
  },
  registrySources: [
    "libs/cua-driver/rust/crates/platform-macos/src/tools/mod.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/tools/mod.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs",
    "libs/cua-driver/rust/crates/platform-linux/src/tools/mod.rs",
    "libs/cua-driver/rust/crates/platform-linux/src/tools/impl_.rs",
    "libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs",
    "libs/cua-driver/rust/crates/cua-driver-core/src/clipboard.rs",
    "libs/cua-driver/rust/crates/cua-driver-core/src/tool.rs",
  ],
  contractManifestSource: "libs/cua-driver/contract/manifest.json",
} as const;

export const PEEKABOO_PROVIDER_PARITY_SOURCE = {
  sourceCommit: "f8f5cbc0cf75d7a39c53c23fea897f0f9a2d93a0",
  catalogToolCount: 26,
  catalogSource: "Core/PeekabooCore/Sources/PeekabooAgentRuntime/MCP/Server/MCPToolCatalog.swift",
  toolSourceRoot: "Core/PeekabooCore/Sources/PeekabooAgentRuntime/MCP/Tools",
} as const;

export const CUA_MCP_TOOL_NAMES = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "kill_app",
  "bring_to_front",
  "set_window_frame",
  "invoke_menu",
  "debug_window_info",
  "click",
  "double_click",
  "right_click",
  "drag",
  "mouse_button_down",
  "mouse_drag",
  "mouse_button_up",
  "parallel_mouse_drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "clipboard_read",
  "clipboard_write",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "move_cursor",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "get_agent_cursor_state",
  "check_permissions",
  "health_report",
  "get_config",
  "set_config",
  "get_accessibility_tree",
  "zoom",
  "page",
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
  "start_recording",
  "stop_recording",
  "get_recording_state",
  "replay_trajectory",
  "install_ffmpeg",
  "start_session",
  "escalate_session",
  "get_session_state",
  "end_session",
] as const;

export type CuaMcpToolName = (typeof CUA_MCP_TOOL_NAMES)[number];
export type CuaPlatform = "macos" | "windows" | "linux";

type CuaPortableActionClassification = {
  tool: CuaMcpToolName;
  platforms: readonly CuaPlatform[];
  classification: "portable-action";
  actions: readonly ComputerUseV2ActionName[];
  reason?: string;
};

type CuaNonPortableClassification = {
  tool: CuaMcpToolName;
  platforms: readonly CuaPlatform[];
  classification:
    | "consolidated-alias"
    | "node-internal-lifecycle"
    | "local-maintenance"
    | "omitted-legacy";
  reason: string;
};

export type CuaMcpToolClassification =
  | CuaPortableActionClassification
  | CuaNonPortableClassification;

const CUA_ALL_PLATFORMS = ["macos", "windows", "linux"] as const;
const CUA_WINDOWS_ONLY = ["windows"] as const;
const CUA_LINUX_ONLY = ["linux"] as const;

export const CUA_MCP_TOOL_PARITY = [
  {
    tool: "list_apps",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["list_apps"],
  },
  {
    tool: "list_windows",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["list_windows"],
  },
  {
    tool: "get_window_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["get_window_state"],
  },
  {
    tool: "verify_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "consolidated-alias",
    reason: "Structured verification is consolidated into v2 action result envelopes.",
  },
  {
    tool: "launch_app",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["launch_app"],
  },
  {
    tool: "kill_app",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["kill_app"],
  },
  {
    tool: "bring_to_front",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["bring_to_front"],
  },
  {
    tool: "set_window_frame",
    platforms: CUA_ALL_PLATFORMS,
    classification: "omitted-legacy",
    reason: "Window geometry mutation is intentionally absent from the frozen v2 action union.",
  },
  {
    tool: "invoke_menu",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["invoke_menu"],
  },
  {
    tool: "debug_window_info",
    platforms: CUA_WINDOWS_ONLY,
    classification: "local-maintenance",
    reason: "Windows registry diagnostics stay local to the node host.",
  },
  {
    tool: "click",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["left_click", "right_click", "middle_click", "double_click", "triple_click"],
  },
  {
    tool: "double_click",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["double_click"],
  },
  {
    tool: "right_click",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["right_click"],
  },
  {
    tool: "drag",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["left_click_drag"],
  },
  {
    tool: "mouse_button_down",
    platforms: CUA_LINUX_ONLY,
    classification: "portable-action",
    actions: ["left_mouse_down"],
  },
  {
    tool: "mouse_drag",
    platforms: CUA_LINUX_ONLY,
    classification: "portable-action",
    actions: ["left_click_drag"],
  },
  {
    tool: "mouse_button_up",
    platforms: CUA_LINUX_ONLY,
    classification: "portable-action",
    actions: ["left_mouse_up"],
  },
  {
    tool: "parallel_mouse_drag",
    platforms: CUA_LINUX_ONLY,
    classification: "consolidated-alias",
    reason: "Multi-cursor batch dragging is consolidated to one v2 action per call.",
  },
  {
    tool: "type_text",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["type"],
  },
  {
    tool: "press_key",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["key"],
  },
  {
    tool: "hotkey",
    platforms: CUA_ALL_PLATFORMS,
    classification: "consolidated-alias",
    reason: "Key chords are represented by the portable key action.",
  },
  {
    tool: "set_value",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["set_value"],
  },
  {
    tool: "scroll",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["scroll"],
  },
  {
    tool: "clipboard_read",
    platforms: CUA_ALL_PLATFORMS,
    classification: "omitted-legacy",
    reason: "The v2 computer-use contract has no raw system-clipboard action.",
  },
  {
    tool: "clipboard_write",
    platforms: CUA_ALL_PLATFORMS,
    classification: "omitted-legacy",
    reason: "The v2 computer-use contract has no raw system-clipboard action.",
  },
  {
    tool: "get_screen_size",
    platforms: CUA_ALL_PLATFORMS,
    classification: "consolidated-alias",
    reason: "Screen dimensions travel with screenshot observations.",
  },
  {
    tool: "get_desktop_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["screenshot"],
  },
  {
    tool: "get_cursor_position",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["get_cursor_position"],
  },
  {
    tool: "move_cursor",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["mouse_move"],
  },
  {
    tool: "set_agent_cursor_enabled",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Agent cursor visibility is node-local UX state.",
  },
  {
    tool: "set_agent_cursor_motion",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Agent cursor motion styling is node-local UX state.",
  },
  {
    tool: "set_agent_cursor_theme",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Agent cursor theming is node-local UX state.",
  },
  {
    tool: "get_agent_cursor_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Agent cursor presentation state is node-local UX state.",
  },
  {
    tool: "check_permissions",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Permission readiness belongs to local setup and diagnostics.",
  },
  {
    tool: "health_report",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Driver health reporting belongs to local setup and diagnostics.",
  },
  {
    tool: "get_config",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Native driver configuration stays under node ownership.",
  },
  {
    tool: "set_config",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Native driver configuration stays under node ownership.",
  },
  {
    tool: "get_accessibility_tree",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["get_accessibility_tree"],
  },
  {
    tool: "zoom",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["zoom"],
  },
  {
    tool: "page",
    platforms: CUA_ALL_PLATFORMS,
    classification: "omitted-legacy",
    reason: "The legacy page tool is superseded by typed browser actions.",
  },
  {
    tool: "get_browser_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["get_browser_state"],
  },
  {
    tool: "browser_prepare",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_prepare"],
  },
  {
    tool: "browser_navigate",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_navigate"],
  },
  {
    tool: "browser_click",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_click"],
  },
  {
    tool: "browser_type",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_type"],
  },
  {
    tool: "browser_dialog",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_dialog"],
  },
  {
    tool: "browser_set_input_files",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_set_input_files"],
  },
  {
    tool: "browser_download",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_download"],
  },
  {
    tool: "browser_pointer",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["browser_pointer"],
  },
  {
    tool: "start_recording",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["start_recording"],
  },
  {
    tool: "stop_recording",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["stop_recording"],
  },
  {
    tool: "get_recording_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["get_recording_state"],
  },
  {
    tool: "replay_trajectory",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["replay_trajectory"],
  },
  {
    tool: "install_ffmpeg",
    platforms: CUA_ALL_PLATFORMS,
    classification: "local-maintenance",
    reason: "Helper installation is local artifact management.",
  },
  {
    tool: "start_session",
    platforms: CUA_ALL_PLATFORMS,
    classification: "node-internal-lifecycle",
    reason: "The node opens the provider session for an execution.",
  },
  {
    tool: "escalate_session",
    platforms: CUA_ALL_PLATFORMS,
    classification: "portable-action",
    actions: ["escalate_scope"],
  },
  {
    tool: "get_session_state",
    platforms: CUA_ALL_PLATFORMS,
    classification: "node-internal-lifecycle",
    reason: "Provider session state is owned by the node execution.",
  },
  {
    tool: "end_session",
    platforms: CUA_ALL_PLATFORMS,
    classification: "node-internal-lifecycle",
    reason: "The node closes the provider session on every terminal path.",
  },
] as const satisfies readonly CuaMcpToolClassification[];

export const PEEKABOO_MCP_TOOL_NAMES = [
  "image",
  "capture",
  "analyze",
  "browser",
  "permissions",
  "sleep",
  "see",
  "inspect_ui",
  "verify_state",
  "click",
  "type",
  "set_value",
  "action",
  "scroll",
  "press",
  "drag",
  "move",
  "app",
  "window",
  "menu",
  "clipboard",
  "paste",
  "agent",
  "dock",
  "dialog",
  "space",
] as const;

export type PeekabooMcpToolName = (typeof PEEKABOO_MCP_TOOL_NAMES)[number];

type PeekabooPortableActionClassification = {
  tool: PeekabooMcpToolName;
  classification: "portable-action";
  actions: readonly ComputerUseV2ActionName[];
  reason?: string;
};

type PeekabooNonPortableClassification = {
  tool: PeekabooMcpToolName;
  classification: "extra-capability" | "node-internal" | "out-of-scope";
  reason: string;
};

export type PeekabooMcpToolClassification =
  | PeekabooPortableActionClassification
  | PeekabooNonPortableClassification;

export const PEEKABOO_MCP_TOOL_PARITY = [
  { tool: "image", classification: "portable-action", actions: ["screenshot"] },
  {
    tool: "capture",
    classification: "portable-action",
    actions: ["screenshot"],
    reason:
      "The screenshot slice is portable; tracking and video-file output remain provider-specific.",
  },
  {
    tool: "analyze",
    classification: "out-of-scope",
    reason: "Provider/model image analysis is outside the computer-use action contract.",
  },
  {
    tool: "browser",
    classification: "portable-action",
    actions: [
      "get_browser_state",
      "browser_prepare",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_dialog",
      "browser_set_input_files",
      "browser_pointer",
    ],
  },
  {
    tool: "permissions",
    classification: "node-internal",
    reason: "Permission readiness belongs to node-local setup and diagnostics.",
  },
  { tool: "sleep", classification: "portable-action", actions: ["wait"] },
  { tool: "see", classification: "portable-action", actions: ["screenshot", "get_window_state"] },
  { tool: "inspect_ui", classification: "portable-action", actions: ["get_accessibility_tree"] },
  {
    tool: "verify_state",
    classification: "extra-capability",
    reason:
      "Candidate v2 addition: deterministic predicates are richer than the frozen result envelope.",
  },
  {
    tool: "click",
    classification: "portable-action",
    actions: ["left_click", "right_click", "double_click"],
  },
  { tool: "type", classification: "portable-action", actions: ["type"] },
  { tool: "set_value", classification: "portable-action", actions: ["set_value"] },
  {
    tool: "action",
    classification: "extra-capability",
    reason:
      "Candidate v2 addition: generic accessibility actions are not named by the frozen union.",
  },
  { tool: "scroll", classification: "portable-action", actions: ["scroll"] },
  { tool: "press", classification: "portable-action", actions: ["key", "hold_key"] },
  { tool: "drag", classification: "portable-action", actions: ["left_click_drag"] },
  { tool: "move", classification: "portable-action", actions: ["mouse_move"] },
  {
    tool: "app",
    classification: "portable-action",
    actions: ["list_apps", "launch_app", "kill_app", "bring_to_front"],
  },
  {
    tool: "window",
    classification: "portable-action",
    actions: ["list_windows", "bring_to_front"],
  },
  { tool: "menu", classification: "portable-action", actions: ["invoke_menu"] },
  {
    tool: "clipboard",
    classification: "extra-capability",
    reason: "Candidate v2 addition: the frozen union has no system-clipboard action.",
  },
  {
    tool: "paste",
    classification: "extra-capability",
    reason: "Candidate v2 addition: atomic background paste is distinct from typing.",
  },
  {
    tool: "agent",
    classification: "out-of-scope",
    reason: "A recursive provider agent is not a portable computer action.",
  },
  {
    tool: "dock",
    classification: "extra-capability",
    reason: "Candidate v2 addition: Dock inspection and menus are macOS-specific capabilities.",
  },
  {
    tool: "dialog",
    classification: "extra-capability",
    reason: "Candidate v2 addition: native dialogs are distinct from browser dialogs.",
  },
  {
    tool: "space",
    classification: "extra-capability",
    reason: "Candidate v2 addition: macOS Space management is not in the frozen union.",
  },
] as const satisfies readonly PeekabooMcpToolClassification[];

type DeliveryModeSupport = {
  modes: readonly ComputerUseDeliveryMode[];
  defaultMode?: ComputerUseDeliveryMode;
  note: string;
};

type MappedProviderActionSupport = {
  action: ComputerUseV2ActionName;
  support: "cua" | "peekaboo" | "both";
  cuaTools: readonly CuaMcpToolName[];
  peekabooTools: readonly PeekabooMcpToolName[];
  deliveryModes?: Partial<Record<ComputerUseProviderId, DeliveryModeSupport>>;
};

type UnmappedProviderActionSupport = {
  action: ComputerUseV2ActionName;
  support: "unmapped";
  cuaTools: readonly [];
  peekabooTools: readonly [];
  unmappedReason: string;
};

export type ComputerUseV2ProviderActionSupport =
  | MappedProviderActionSupport
  | UnmappedProviderActionSupport;

const CUA_BACKGROUND_FOREGROUND = {
  modes: ["background", "foreground"],
  note: "The pinned CUA tools/list schema exposes a per-call delivery_mode enum.",
} as const;

const CUA_LINUX_BACKGROUND_ONLY = {
  modes: ["background"],
  defaultMode: "background",
  note: "The Linux held-button tools explicitly use background window delivery.",
} as const;

const PEEKABOO_CLICK_BACKGROUND_DEFAULT = {
  modes: ["background", "foreground"],
  defaultMode: "background",
  note: "ClickTool defaults to background delivery and accepts foreground=true as the opt-in.",
} as const;

const PEEKABOO_TARGETED_BACKGROUND_DEFAULT = {
  modes: ["background", "foreground"],
  defaultMode: "background",
  note: "The targeted input schema defaults foreground=false and accepts foreground=true as the opt-in.",
} as const;

const PEEKABOO_FOREGROUND_ONLY = {
  modes: ["foreground"],
  defaultMode: "foreground",
  note: "The tool requires foreground confirmation because it drives the shared physical pointer.",
} as const;

const PEEKABOO_BACKGROUND_ONLY = {
  modes: ["background"],
  defaultMode: "background",
  note: "The tool dispatches through accessibility without a foreground option.",
} as const;

export const COMPUTER_USE_V2_PROVIDER_ACTION_SUPPORT = [
  {
    action: "screenshot",
    support: "both",
    cuaTools: ["get_desktop_state"],
    peekabooTools: ["image", "capture", "see"],
  },
  {
    action: "left_click",
    support: "both",
    cuaTools: ["click"],
    peekabooTools: ["click"],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND, peekaboo: PEEKABOO_CLICK_BACKGROUND_DEFAULT },
  },
  {
    action: "right_click",
    support: "both",
    cuaTools: ["right_click", "click"],
    peekabooTools: ["click"],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND, peekaboo: PEEKABOO_CLICK_BACKGROUND_DEFAULT },
  },
  {
    action: "middle_click",
    support: "cua",
    cuaTools: ["click"],
    peekabooTools: [],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND },
  },
  {
    action: "double_click",
    support: "both",
    cuaTools: ["double_click", "click"],
    peekabooTools: ["click"],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND, peekaboo: PEEKABOO_CLICK_BACKGROUND_DEFAULT },
  },
  {
    action: "triple_click",
    support: "cua",
    cuaTools: ["click"],
    peekabooTools: [],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND },
  },
  {
    action: "mouse_move",
    support: "both",
    cuaTools: ["move_cursor"],
    peekabooTools: ["move"],
    deliveryModes: { peekaboo: PEEKABOO_FOREGROUND_ONLY },
  },
  {
    action: "left_click_drag",
    support: "both",
    cuaTools: ["drag", "mouse_drag"],
    peekabooTools: ["drag"],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND, peekaboo: PEEKABOO_FOREGROUND_ONLY },
  },
  {
    action: "left_mouse_down",
    support: "cua",
    cuaTools: ["mouse_button_down"],
    peekabooTools: [],
    deliveryModes: { cua: CUA_LINUX_BACKGROUND_ONLY },
  },
  {
    action: "left_mouse_up",
    support: "cua",
    cuaTools: ["mouse_button_up"],
    peekabooTools: [],
    deliveryModes: { cua: CUA_LINUX_BACKGROUND_ONLY },
  },
  {
    action: "scroll",
    support: "both",
    cuaTools: ["scroll"],
    peekabooTools: ["scroll"],
    deliveryModes: {
      cua: CUA_BACKGROUND_FOREGROUND,
      peekaboo: PEEKABOO_TARGETED_BACKGROUND_DEFAULT,
    },
  },
  {
    action: "type",
    support: "both",
    cuaTools: ["type_text"],
    peekabooTools: ["type"],
    deliveryModes: {
      cua: CUA_BACKGROUND_FOREGROUND,
      peekaboo: PEEKABOO_TARGETED_BACKGROUND_DEFAULT,
    },
  },
  {
    action: "key",
    support: "both",
    cuaTools: ["press_key", "hotkey"],
    peekabooTools: ["press"],
    deliveryModes: {
      cua: CUA_BACKGROUND_FOREGROUND,
      peekaboo: PEEKABOO_TARGETED_BACKGROUND_DEFAULT,
    },
  },
  {
    action: "hold_key",
    support: "peekaboo",
    cuaTools: [],
    peekabooTools: ["press"],
    deliveryModes: { peekaboo: PEEKABOO_TARGETED_BACKGROUND_DEFAULT },
  },
  { action: "wait", support: "peekaboo", cuaTools: [], peekabooTools: ["sleep"] },
  { action: "list_apps", support: "both", cuaTools: ["list_apps"], peekabooTools: ["app"] },
  {
    action: "list_windows",
    support: "both",
    cuaTools: ["list_windows"],
    peekabooTools: ["window"],
  },
  {
    action: "get_accessibility_tree",
    support: "both",
    cuaTools: ["get_accessibility_tree"],
    peekabooTools: ["inspect_ui"],
  },
  {
    action: "get_cursor_position",
    support: "cua",
    cuaTools: ["get_cursor_position"],
    peekabooTools: [],
  },
  {
    action: "get_window_state",
    support: "both",
    cuaTools: ["get_window_state"],
    peekabooTools: ["see"],
  },
  { action: "launch_app", support: "both", cuaTools: ["launch_app"], peekabooTools: ["app"] },
  { action: "kill_app", support: "both", cuaTools: ["kill_app"], peekabooTools: ["app"] },
  {
    action: "bring_to_front",
    support: "both",
    cuaTools: ["bring_to_front"],
    peekabooTools: ["app", "window"],
  },
  {
    action: "set_value",
    support: "both",
    cuaTools: ["set_value"],
    peekabooTools: ["set_value"],
    deliveryModes: { peekaboo: PEEKABOO_BACKGROUND_ONLY },
  },
  { action: "zoom", support: "cua", cuaTools: ["zoom"], peekabooTools: [] },
  {
    action: "get_browser_state",
    support: "both",
    cuaTools: ["get_browser_state"],
    peekabooTools: ["browser"],
  },
  {
    action: "browser_prepare",
    support: "both",
    cuaTools: ["browser_prepare"],
    peekabooTools: ["browser"],
  },
  {
    action: "browser_navigate",
    support: "both",
    cuaTools: ["browser_navigate"],
    peekabooTools: ["browser"],
  },
  {
    action: "browser_click",
    support: "both",
    cuaTools: ["browser_click"],
    peekabooTools: ["browser"],
  },
  {
    action: "browser_type",
    support: "both",
    cuaTools: ["browser_type"],
    peekabooTools: ["browser"],
  },
  {
    action: "browser_dialog",
    support: "both",
    cuaTools: ["browser_dialog"],
    peekabooTools: ["browser"],
    deliveryModes: { cua: CUA_BACKGROUND_FOREGROUND },
  },
  {
    action: "browser_set_input_files",
    support: "both",
    cuaTools: ["browser_set_input_files"],
    peekabooTools: ["browser"],
  },
  { action: "browser_download", support: "cua", cuaTools: ["browser_download"], peekabooTools: [] },
  {
    action: "browser_pointer",
    support: "both",
    cuaTools: ["browser_pointer"],
    peekabooTools: ["browser"],
  },
  { action: "escalate_scope", support: "cua", cuaTools: ["escalate_session"], peekabooTools: [] },
  {
    action: "get_recording_state",
    support: "cua",
    cuaTools: ["get_recording_state"],
    peekabooTools: [],
  },
  { action: "start_recording", support: "cua", cuaTools: ["start_recording"], peekabooTools: [] },
  { action: "stop_recording", support: "cua", cuaTools: ["stop_recording"], peekabooTools: [] },
  {
    action: "replay_trajectory",
    support: "cua",
    cuaTools: ["replay_trajectory"],
    peekabooTools: [],
  },
  {
    action: "invoke_menu",
    support: "both",
    cuaTools: ["invoke_menu"],
    peekabooTools: ["menu"],
    deliveryModes: { peekaboo: PEEKABOO_TARGETED_BACKGROUND_DEFAULT },
  },
] as const satisfies readonly ComputerUseV2ProviderActionSupport[];

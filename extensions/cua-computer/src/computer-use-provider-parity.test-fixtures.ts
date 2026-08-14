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
import type { ComputerUseV2ActionName } from "openclaw/plugin-sdk/computer-use";
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
type CuaPlatform = "macos" | "windows" | "linux";

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

type CuaMcpToolClassification = CuaPortableActionClassification | CuaNonPortableClassification;

const CUA_ALL_PLATFORMS = ["macos", "windows", "linux"] as const;
const CUA_WINDOWS_ONLY = ["windows"] as const;
const CUA_LINUX_ONLY = ["linux"] as const;

export const CUA_MCP_TOOL_PARITY: readonly CuaMcpToolClassification[] = [
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
];

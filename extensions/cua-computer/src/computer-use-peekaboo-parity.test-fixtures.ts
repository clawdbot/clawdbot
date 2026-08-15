/**
 * Frozen design inputs for the computer.act v2 provider contract.
 *
 * Peekaboo and cross-provider evidence comes from the immutable cua-driver-rs-v0.19.3 tag. The runtime
 * registries are larger than the generated portable contract manifest: the
 * manifest has 23 tools, while the platform registries expose 53 on macOS, 54
 * on Windows, and 57 on Linux (58 unique names across all three platforms).
 * Peekaboo evidence comes from its canonical MCPToolCatalog at the pinned
 * source commit below; that catalog contains 26 tools, not the previously
 * documented 25.
 */

import type { ComputerUseV2ActionName } from "openclaw/plugin-sdk/computer-use";
import type {
  ComputerUseDeliveryMode,
  ComputerUseProviderId,
  CuaMcpToolName,
} from "./computer-use-provider-parity.test-fixtures.js";

export const PEEKABOO_PROVIDER_PARITY_SOURCE = {
  sourceCommit: "f8f5cbc0cf75d7a39c53c23fea897f0f9a2d93a0",
  catalogToolCount: 26,
  catalogSource: "Core/PeekabooCore/Sources/PeekabooAgentRuntime/MCP/Server/MCPToolCatalog.swift",
  toolSourceRoot: "Core/PeekabooCore/Sources/PeekabooAgentRuntime/MCP/Tools",
} as const;
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

type PeekabooMcpToolName = (typeof PEEKABOO_MCP_TOOL_NAMES)[number];

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

type PeekabooMcpToolClassification =
  | PeekabooPortableActionClassification
  | PeekabooNonPortableClassification;

export const PEEKABOO_MCP_TOOL_PARITY: readonly PeekabooMcpToolClassification[] = [
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
];

export type DeliveryModeSupport = {
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

type ComputerUseV2ProviderActionSupport =
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

export const COMPUTER_USE_V2_PROVIDER_ACTION_SUPPORT: readonly ComputerUseV2ProviderActionSupport[] =
  [
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
      deliveryModes: {
        cua: CUA_BACKGROUND_FOREGROUND,
        peekaboo: PEEKABOO_CLICK_BACKGROUND_DEFAULT,
      },
    },
    {
      action: "right_click",
      support: "both",
      cuaTools: ["right_click", "click"],
      peekabooTools: ["click"],
      deliveryModes: {
        cua: CUA_BACKGROUND_FOREGROUND,
        peekaboo: PEEKABOO_CLICK_BACKGROUND_DEFAULT,
      },
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
      deliveryModes: {
        cua: CUA_BACKGROUND_FOREGROUND,
        peekaboo: PEEKABOO_CLICK_BACKGROUND_DEFAULT,
      },
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
    {
      action: "browser_download",
      support: "cua",
      cuaTools: ["browser_download"],
      peekabooTools: [],
    },
    {
      action: "browser_pointer",
      support: "both",
      cuaTools: ["browser_pointer"],
      peekabooTools: ["browser"],
    },
    {
      action: "escalate_scope",
      support: "cua",
      cuaTools: ["get_session_state"],
      peekabooTools: [],
    },
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
  ];

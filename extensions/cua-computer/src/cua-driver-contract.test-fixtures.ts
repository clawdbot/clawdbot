import type { CuaToolResult } from "./driver-client.js";

export const CUA_DRIVER_CONTRACT_FIXTURES = {
  listApps: {
    apps: [
      {
        pid: 4242,
        bundle_id: "org.example.Editor",
        name: "Editor",
        running: true,
        active: false,
        kind: "desktop",
        launch_path: "/usr/bin/editor",
        last_used: "2026-08-14T00:00:00Z",
      },
    ],
  },
  listWindows: {
    windows: [
      {
        window_id: 99,
        pid: 4242,
        app_name: "Editor",
        title: "Notes",
        bounds: { x: 40, y: 50, width: 800, height: 600 },
        is_on_screen: true,
        minimized: false,
        z_index: 2,
      },
    ],
  },
  windowState: {
    window_id: 99,
    pid: 4242,
    snapshot_id: "native-snapshot-1",
    total_element_count: 1,
    returned_element_count: 1,
    screenshot_width: 800,
    screenshot_height: 600,
    screenshot_mime_type: "image/png",
    elements: [
      {
        element_index: 7,
        element_token: "native-element-token-7",
        role: "text field",
        label: "Body",
        value: "old",
        frame: { x: 80, y: 100, w: 400, h: 240 },
      },
    ],
  },
  browserBinding: {
    status: "ok",
    mode: "bind",
    target_id: "native-browser-target-1",
    binding_quality: "exact",
    binding_route: "native_cdp_window",
    mutation_allowed: true,
    native_title: "Example",
    tabs: [
      {
        tab_id: "native-page-1",
        title: "Example",
        url: "https://example.com/",
        active: true,
      },
    ],
  },
  browserSnapshot: {
    status: "ok",
    mode: "snapshot",
    target_id: "native-browser-target-1",
    tab_id: "native-page-1",
    snapshot_id: "p7",
    url: "https://example.com/",
    refs: [
      {
        ref: "p7:0",
        node: "BUTTON",
        label: "Continue",
        frame: "main",
      },
      {
        ref: "p7:1",
        node: "INPUT",
        label: "Name",
        frame: "main",
      },
    ],
    truncated: false,
    screenshot_width: 1_280,
    screenshot_height: 720,
  },
  browserPrepare: {
    status: "ok",
    prepared: true,
    action: "launched_isolated_browser",
    message: "launched isolated browser",
    endpoint_ownership: { method: "spawned_by_driver" },
    prepared_pid: 9001,
    side_effects: { launched_browser: true, created_profile: true },
    attachment: null,
  },
  browserNavigate: {
    status: "ok",
    target_id: "native-browser-target-1",
    tab_id: "native-page-1",
    url: "https://example.com/next",
    refs_invalidated: true,
  },
  browserDialog: {
    status: "ok",
    target_id: "native-browser-target-1",
    tab_id: "native-page-1",
    present: true,
    dialog_id: "dialog-4",
    kind: "prompt",
  },
  browserFiles: {
    status: "ok",
    target_id: "native-browser-target-1",
    tab_id: "native-page-1",
    ref: "p7:1",
    frame: "main",
    file_count: 1,
  },
  browserDownload: {
    status: "completed",
    download_id: "opaque-download-guid",
    bytes: 42,
  },
  recordingActive: {
    recording: true,
    enabled: true,
    output_dir: "/native/recording",
    next_turn: 1,
    last_error: null,
    video_active: false,
    last_video_path: null,
    owner: "native-session",
  },
  recordingStopped: {
    recording: false,
    enabled: false,
    output_dir: null,
    next_turn: 1,
    last_error: null,
    video_active: false,
    last_video_path: "/native/recording/recording.mp4",
    owner: null,
  },
  replay: {
    directory: "/native/recording",
    attempted: 1,
    succeeded: 1,
    failed: 0,
    stop_on_error: true,
    turns: [{ turn: "turn-00001", tool: "click", ok: true, result_summary: "ok" }],
  },
  confirmedBackgroundAction: {
    effect: 0,
    route: 0,
    delivery: { mode: 0, deliveredCount: 1 },
    evidence: [{ kind: 0 }],
  },
  suspectedNoopAction: {
    effect: 3,
    route: 1,
    delivery: { mode: 0 },
    escalation: { target: 1, reason: 3 },
  },
} as const;

export function cuaToolResult(
  structured: Record<string, unknown>,
  options: {
    action?: CuaToolResult["action"];
    image?: boolean;
    isError?: boolean;
    errorCode?: string;
    text?: string;
  } = {},
): CuaToolResult {
  return {
    text: options.text ?? "ok",
    images: options.image
      ? [{ mimeType: "image/png", dataBase64: Buffer.from("png").toString("base64") }]
      : [],
    structuredJson: JSON.stringify(structured),
    isError: options.isError ?? false,
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    ...(options.action ? { action: options.action } : {}),
    degraded: false,
    rawJson: "{}",
  };
}

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

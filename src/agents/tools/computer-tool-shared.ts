import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../../plugins/computer-use-contract.js";

export const COMPUTER_ACT_COMMAND = "computer.act";
export const SCREEN_SNAPSHOT_COMMAND = "screen.snapshot";

export const COMPUTER_REF_WIDTH = 1280;
export const SCREENSHOT_QUALITY = 0.85;
export const AFTER_ACTION_SCREENSHOT_DELAY_MS = 500;
export const MAX_WAIT_SECONDS = 100;
export const MAX_HOLD_SECONDS = 10;
export const MODEL_OBSERVATION_MAX_ELEMENTS = 200;

export type ComputerToolAction = ComputerUseV2ActionName;

const COMPUTER_OBSERVATION_ACTIONS = new Set<string>([
  "screenshot",
  "wait",
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_window_state",
  "zoom",
  "get_browser_state",
  "get_recording_state",
] satisfies ComputerToolAction[]);

// Observations may refresh frame/ref caches, but do not perform setup or input.
// Keep result handling and replay classification on the same action contract.
export function isComputerObservationAction(
  action: string | undefined,
  dialogAction?: unknown,
): boolean {
  return (
    action !== undefined &&
    (COMPUTER_OBSERVATION_ACTIONS.has(action) ||
      (action === "browser_dialog" && dialogAction === "inspect"))
  );
}

/** The owner binds the execution target and revalidates its authority before every dispatch. */
export type ComputerToolTransport = {
  readonly computerUse?: ComputerUseCapabilityDescriptor;
  resolveNode: (
    query?: string,
    signal?: AbortSignal,
  ) => Promise<{ nodeId: string; computerUse?: ComputerUseCapabilityDescriptor }>;
  invoke: (params: {
    nodeId: string;
    command: typeof COMPUTER_ACT_COMMAND | typeof SCREEN_SNAPSHOT_COMMAND;
    commandParams: Record<string, unknown>;
    timeoutMs?: number;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

export type ComputerTarget = { nodeId: string; screenIndex: number };

export type ComputerFrame = {
  target: ComputerTarget;
  id: string;
  displayFrameId: string;
  contextEpoch: number;
};

export type ScreenshotCapture = {
  base64: string;
  displayFrameId: string;
  mimeType: string;
  width?: number;
  height?: number;
};

export type ComputerObservationState = {
  nodeId: string;
  providerGeneration: string;
  observationId: string;
  imageCoordinates?:
    | { kind: "unavailable" }
    | { kind: "available"; scaleX: number; scaleY: number };
};

export type ComputerContextEpoch = {
  value: number;
  /** Tool result whose screenshot currently authorizes coordinates. */
  frameToolCallId?: string;
  /** Digest of the exact sanitized image the model received for that result. */
  frameImageIdentity?: string;
};

export type ResolvedComputerTarget = {
  target: ComputerTarget;
  frame?: ComputerFrame;
  capabilities?: ComputerUseCapabilityDescriptor;
};

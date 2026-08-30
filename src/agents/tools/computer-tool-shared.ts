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

export const COMPUTER_TOOL_LOCAL_ACTIONS = [
  "screenshot",
  "wait",
] as const satisfies readonly ComputerToolAction[];

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

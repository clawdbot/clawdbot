import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type {
  ComputerActParams,
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../../plugins/computer-use-contract.js";
import {
  COMPUTER_ACT_V1_ACTION_NAMES,
  COMPUTER_CONTRACT_MISMATCH,
  COMPUTER_STALE_OBSERVATION,
  COMPUTER_USE_V2_ACTION_NAMES,
} from "../../plugins/computer-use-contract.js";
import { readFiniteNumberParam, readPositiveIntegerParam, readToolStringParam } from "./common.js";
import type { ComputerObservationState, ComputerToolAction } from "./computer-tool-shared.js";
import { COMPUTER_REF_WIDTH, MAX_HOLD_SECONDS } from "./computer-tool-shared.js";

const LOCAL_ACTIONS = new Set<ComputerUseV2ActionName>(["screenshot", "wait"]);
const INPUT_ACTIONS = new Set<ComputerUseV2ActionName>(
  COMPUTER_USE_V2_ACTION_NAMES.filter((action) => !LOCAL_ACTIONS.has(action)),
);

const COORDINATE_REQUIRED_ACTIONS = new Set<ComputerToolAction>([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
]);

const ELEMENT_TARGETABLE_CLICK_ACTIONS = new Set<ComputerToolAction>([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
]);

const COORDINATE_OPTIONAL_ACTIONS = new Set<ComputerToolAction>([
  "scroll",
  "left_mouse_down",
  "left_mouse_up",
]);

const MODIFIER_TEXT_ACTIONS = new Set<ComputerToolAction>([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
]);

const POINTER_OR_KEYBOARD_ACTIONS = new Set<ComputerToolAction>(COMPUTER_ACT_V1_ACTION_NAMES);
const ESCALATION_REASONS = new Set([
  "ax_tree_pixel_mismatch",
  "background_delivery_failed",
  "foreground_ineffective",
  "no_window_target",
  "other",
]);
const READ_ONLY_COMPUTER_ACT_ACTIONS = new Set<ComputerUseV2ActionName>([
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_window_state",
  "zoom",
  "get_browser_state",
  "get_recording_state",
]);
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

function isScrollDirection(value: string): value is (typeof SCROLL_DIRECTIONS)[number] {
  return SCROLL_DIRECTIONS.some((direction) => direction === value);
}

export function isComputerActAction(action: ComputerToolAction): boolean {
  return INPUT_ACTIONS.has(action);
}

export function isReadOnlyComputerActAction(action: ComputerToolAction): boolean {
  return READ_ONLY_COMPUTER_ACT_ACTIONS.has(action);
}

export function computerActionNeedsFrame(
  action: ComputerToolAction,
  input: Record<string, unknown>,
): boolean {
  return (
    !input.windowRef &&
    !input.elementRef &&
    (COORDINATE_REQUIRED_ACTIONS.has(action) ||
      (COORDINATE_OPTIONAL_ACTIONS.has(action) && Array.isArray(input.coordinate)))
  );
}

function readCoordinate(
  params: Record<string, unknown>,
  key: "coordinate" | "startCoordinate",
): [number, number] | undefined {
  const raw = params[key];
  if (raw === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    raw.some(
      (entry) =>
        typeof entry !== "number" ||
        !Number.isFinite(entry) ||
        !Number.isInteger(entry) ||
        entry < 0,
    )
  ) {
    throw new Error(`${key} must be a pair of non-negative integers`);
  }
  return [raw[0] as number, raw[1] as number];
}

function requireCoordinate(params: Record<string, unknown>, action: string): [number, number] {
  const coordinate = readCoordinate(params, "coordinate");
  if (!coordinate) {
    throw new Error(`coordinate [x, y] required for ${action}`);
  }
  return [coordinate[0], coordinate[1]];
}

function readModifiers(params: Record<string, unknown>, action: ComputerToolAction) {
  if (!MODIFIER_TEXT_ACTIONS.has(action)) {
    return undefined;
  }
  const text = typeof params.text === "string" ? params.text.trim() : "";
  return text ? text : undefined;
}

function copyOptionalStringParam(
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
): void {
  const value = readToolStringParam(input, key);
  if (value !== undefined) {
    target[key] = value;
  }
}

function copyOptionalIntegerParam(
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
): void {
  const value = readFiniteNumberParam(input, key, bounds);
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  target[key] = value;
}

function copyDeliveryMode(target: Record<string, unknown>, input: Record<string, unknown>): void {
  const deliveryMode = normalizeOptionalLowercaseString(input.deliveryMode);
  if (deliveryMode === undefined) {
    return;
  }
  if (deliveryMode !== "background" && deliveryMode !== "foreground") {
    throw new Error("deliveryMode must be background or foreground");
  }
  target.deliveryMode = deliveryMode;
}

function copyOptionalBooleanParam(
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
): void {
  const value = input[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  target[key] = value;
}

function copyBrowserRefs(target: Record<string, unknown>, input: Record<string, unknown>): void {
  target.browserRef = readToolStringParam(input, "browserRef", { required: true });
  target.pageRef = readToolStringParam(input, "pageRef", { required: true });
}

/** Builds the computer.act wire params for one tool input action. */
export function buildComputerActParams(params: {
  action: ComputerToolAction;
  input: Record<string, unknown>;
  executionId: string;
  screenIndex: number;
  displayFrameId?: string;
  refWidth?: number;
}): ComputerActParams {
  const { action, input } = params;
  const wire: Record<string, unknown> = { action, executionId: params.executionId };
  if ((COMPUTER_ACT_V1_ACTION_NAMES as readonly string[]).includes(action)) {
    wire.screenIndex = params.screenIndex;
    wire.refWidth = params.refWidth ?? COMPUTER_REF_WIDTH;
  }
  const elementRef = readToolStringParam(input, "elementRef");
  if (
    COORDINATE_REQUIRED_ACTIONS.has(action) &&
    !(elementRef && ELEMENT_TARGETABLE_CLICK_ACTIONS.has(action))
  ) {
    const [x, y] = requireCoordinate(input, action);
    wire.x = x;
    wire.y = y;
  } else if (COORDINATE_OPTIONAL_ACTIONS.has(action)) {
    const coordinate = readCoordinate(input, "coordinate");
    if (coordinate) {
      wire.x = coordinate[0];
      wire.y = coordinate[1];
    }
  }
  if ((wire.x !== undefined || wire.fromX !== undefined) && params.displayFrameId) {
    wire.displayFrameId = params.displayFrameId;
  }
  const modifiers = readModifiers(input, action);
  if (modifiers) {
    wire.modifiers = modifiers;
  }
  switch (action) {
    case "left_click_drag": {
      const start = readCoordinate(input, "startCoordinate");
      if (!start) {
        throw new Error("startCoordinate [x, y] required for left_click_drag");
      }
      wire.fromX = start[0];
      wire.fromY = start[1];
      break;
    }
    case "scroll": {
      const direction = normalizeOptionalLowercaseString(input.scrollDirection);
      if (!direction || !isScrollDirection(direction)) {
        throw new Error("scrollDirection up|down|left|right required for scroll");
      }
      wire.scrollDirection = direction;
      const amount = readPositiveIntegerParam(input, "scrollAmount") ?? 3;
      wire.scrollAmount = Math.min(100, amount);
      break;
    }
    case "type": {
      const text = typeof input.text === "string" ? input.text : "";
      if (!text) {
        throw new Error("text required for type");
      }
      wire.text = text;
      break;
    }
    case "key":
    case "hold_key": {
      const keys = readToolStringParam(input, "text", { required: true });
      wire.keys = keys;
      if (action === "hold_key") {
        const seconds =
          readFiniteNumberParam(input, "duration", {
            min: 0,
            minExclusive: true,
            max: MAX_HOLD_SECONDS,
            message: `duration must be >0 and <=${MAX_HOLD_SECONDS} seconds for hold_key`,
          }) ?? 1;
        wire.durationMs = Math.round(seconds * 1000);
      }
      break;
    }
    case "get_accessibility_tree": {
      copyOptionalStringParam(wire, input, "windowRef");
      copyOptionalStringParam(wire, input, "query");
      copyOptionalIntegerParam(wire, input, "depth", { min: 0, max: 64 });
      copyOptionalIntegerParam(wire, input, "maxElements", { min: 1, max: 2_000 });
      break;
    }
    case "get_window_state": {
      wire.windowRef = readToolStringParam(input, "windowRef", { required: true });
      copyOptionalStringParam(wire, input, "query");
      copyOptionalIntegerParam(wire, input, "depth", { min: 0, max: 64 });
      copyOptionalIntegerParam(wire, input, "maxElements", { min: 1, max: 2_000 });
      break;
    }
    case "launch_app":
    case "kill_app": {
      wire.app = readToolStringParam(input, "app", { required: true });
      break;
    }
    case "bring_to_front": {
      wire.windowRef = readToolStringParam(input, "windowRef", { required: true });
      break;
    }
    case "set_value": {
      for (const key of ["windowRef", "elementRef", "observationId", "value"] as const) {
        wire[key] = readToolStringParam(input, key, {
          required: true,
          allowEmpty: key === "value",
        });
      }
      copyDeliveryMode(wire, input);
      break;
    }
    case "invoke_menu": {
      wire.windowRef = readToolStringParam(input, "windowRef", { required: true });
      const path = input.path;
      if (
        !Array.isArray(path) ||
        path.length < 1 ||
        path.length > 16 ||
        path.some((segment) => typeof segment !== "string" || !segment.trim())
      ) {
        throw new Error("path must contain 1-16 non-empty menu labels");
      }
      wire.path = path;
      copyDeliveryMode(wire, input);
      break;
    }
    case "zoom": {
      wire.windowRef = readToolStringParam(input, "windowRef", { required: true });
      wire.observationId = readToolStringParam(input, "observationId", { required: true });
      for (const key of ["x1", "y1", "x2", "y2"] as const) {
        const value = readFiniteNumberParam(input, key, { min: 0 });
        if (value === undefined) {
          throw new Error(`${key} required for zoom`);
        }
        wire[key] = value;
      }
      break;
    }
    case "get_browser_state": {
      const windowRef = readToolStringParam(input, "windowRef");
      if (windowRef) {
        wire.windowRef = windowRef;
        break;
      }
      copyBrowserRefs(wire, input);
      for (const key of [
        "snapshotFormat",
        "elementRef",
        "observationId",
        "query",
        "continuation",
      ] as const) {
        copyOptionalStringParam(wire, input, key);
      }
      copyOptionalBooleanParam(wire, input, "includeScreenshot");
      break;
    }
    case "browser_prepare": {
      wire.windowRef = readToolStringParam(input, "windowRef", { required: true });
      copyOptionalStringParam(wire, input, "profile");
      copyOptionalStringParam(wire, input, "profileName");
      break;
    }
    case "browser_navigate": {
      copyBrowserRefs(wire, input);
      wire.url = readToolStringParam(input, "url", { required: true });
      break;
    }
    case "browser_click": {
      copyBrowserRefs(wire, input);
      wire.observationId = readToolStringParam(input, "observationId", { required: true });
      copyOptionalStringParam(wire, input, "elementRef");
      copyOptionalStringParam(wire, input, "inputRoute");
      const coordinate = readCoordinate(input, "coordinate");
      if (coordinate) {
        wire.x = coordinate[0];
        wire.y = coordinate[1];
      }
      break;
    }
    case "browser_type": {
      copyBrowserRefs(wire, input);
      for (const key of ["observationId", "elementRef"] as const) {
        wire[key] = readToolStringParam(input, key, { required: true });
      }
      wire.text = readToolStringParam(input, "text", { required: true, allowEmpty: true });
      copyOptionalStringParam(wire, input, "mode");
      copyOptionalBooleanParam(wire, input, "replace");
      break;
    }
    case "browser_dialog": {
      copyBrowserRefs(wire, input);
      wire.dialogAction = readToolStringParam(input, "dialogAction", { required: true });
      copyOptionalStringParam(wire, input, "dialogRef");
      copyOptionalStringParam(wire, input, "promptText");
      copyDeliveryMode(wire, input);
      break;
    }
    case "browser_set_input_files": {
      copyBrowserRefs(wire, input);
      for (const key of ["observationId", "elementRef"] as const) {
        wire[key] = readToolStringParam(input, key, { required: true });
      }
      const resourceHandles = input.resourceHandles;
      if (
        !Array.isArray(resourceHandles) ||
        resourceHandles.length < 1 ||
        resourceHandles.length > 32 ||
        resourceHandles.some((handle) => typeof handle !== "string" || !handle)
      ) {
        throw new Error("resourceHandles must contain 1-32 opaque resource handles");
      }
      wire.resourceHandles = resourceHandles;
      break;
    }
    case "browser_download": {
      copyBrowserRefs(wire, input);
      for (const key of ["observationId", "elementRef"] as const) {
        wire[key] = readToolStringParam(input, key, { required: true });
      }
      break;
    }
    case "browser_pointer": {
      copyBrowserRefs(wire, input);
      wire.observationId = readToolStringParam(input, "observationId", { required: true });
      wire.pointerAction = readToolStringParam(input, "pointerAction", { required: true });
      for (const key of ["inputRoute", "elementRef", "destinationElementRef"] as const) {
        copyOptionalStringParam(wire, input, key);
      }
      const coordinate = readCoordinate(input, "coordinate");
      if (coordinate) {
        wire.x = coordinate[0];
        wire.y = coordinate[1];
      }
      const destination = input.destinationCoordinate;
      if (destination !== undefined) {
        if (
          !Array.isArray(destination) ||
          destination.length !== 2 ||
          destination.some((value) => typeof value !== "number" || !Number.isFinite(value))
        ) {
          throw new Error("destinationCoordinate must be a pair of finite numbers");
        }
        wire.toX = destination[0];
        wire.toY = destination[1];
      }
      for (const key of ["deltaX", "deltaY"] as const) {
        const value = readFiniteNumberParam(input, key);
        if (value !== undefined) {
          wire[key] = value;
        }
      }
      break;
    }
    case "escalate_scope": {
      const reason = readToolStringParam(input, "reason", { required: true });
      if (!ESCALATION_REASONS.has(reason)) {
        throw new Error("reason must be a supported escalation reason");
      }
      wire.reason = reason;
      break;
    }
    case "start_recording": {
      copyOptionalBooleanParam(wire, input, "recordVideo");
      break;
    }
    case "replay_trajectory": {
      wire.resourceHandle = readToolStringParam(input, "resourceHandle", { required: true });
      copyOptionalIntegerParam(wire, input, "delayMs", { min: 0, max: 10_000 });
      copyOptionalBooleanParam(wire, input, "stopOnError");
      break;
    }
    default:
      break;
  }
  if (POINTER_OR_KEYBOARD_ACTIONS.has(action)) {
    for (const key of ["windowRef", "elementRef", "observationId"] as const) {
      copyOptionalStringParam(wire, input, key);
    }
    copyDeliveryMode(wire, input);
  }
  return wire as ComputerActParams;
}

export function validateCapabilityBoundInput(params: {
  action: ComputerUseV2ActionName;
  input: Record<string, unknown>;
  nodeId: string;
  capabilities?: ComputerUseCapabilityDescriptor;
  observationState?: ComputerObservationState;
}): void {
  const { capabilities, input } = params;
  const windowRef = readToolStringParam(input, "windowRef");
  const browserRef = readToolStringParam(input, "browserRef");
  const pageRef = readToolStringParam(input, "pageRef");
  const elementRef = readToolStringParam(input, "elementRef");
  const observationId = readToolStringParam(input, "observationId");
  const deliveryMode = normalizeOptionalLowercaseString(input.deliveryMode);
  if (windowRef && !capabilities?.targets.includes("window")) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: selected node has no window target support`);
  }
  if (elementRef && !capabilities?.targets.includes("element")) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: selected node has no element target support`);
  }
  if ((browserRef || pageRef) && !capabilities?.targets.includes("browser")) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: selected node has no browser target support`);
  }
  if (deliveryMode && !capabilities?.deliveryModes.includes(deliveryMode as never)) {
    throw new Error(
      `${COMPUTER_CONTRACT_MISMATCH}: selected node does not advertise ${deliveryMode} delivery`,
    );
  }
  if (elementRef && !observationId) {
    throw new Error(`${COMPUTER_STALE_OBSERVATION}: elementRef requires observationId`);
  }
  if (!observationId) {
    return;
  }
  if (
    !params.observationState ||
    params.observationState.nodeId !== params.nodeId ||
    params.observationState.providerGeneration !== capabilities?.provider.generation ||
    params.observationState.observationId !== observationId
  ) {
    throw new Error(`${COMPUTER_STALE_OBSERVATION}: take a fresh observation and retry`);
  }
}

/**
 * computer built-in tool.
 *
 * Drives a paired desktop node with computer_20251124-style actions: reads
 * reuse the screen.snapshot node command as the reference frame and input is
 * routed through the dangerous computer.act node command. The tool cannot
 * tell how a node fulfills computer.act; macOS nodes are the first fulfiller.
 */
import crypto from "node:crypto";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { parseScreenSnapshotPayload } from "../../cli/nodes-screen.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  ComputerActParams,
  ComputerActResult,
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
  ScreenSnapshotParams,
} from "../../plugins/computer-use-contract.js";
import {
  COMPUTER_ACT_V1_ACTION_NAMES,
  COMPUTER_CONTRACT_MISMATCH,
  COMPUTER_STALE_OBSERVATION,
  COMPUTER_USE_V1_ACTION_NAMES,
  COMPUTER_USE_V2_ACTION_NAMES,
  parseComputerActResult,
} from "../../plugins/computer-use-contract.js";
import { sleep } from "../../utils/sleep.js";
import {
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  resolveImageSanitizationLimits,
} from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../schema/typebox.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import {
  type AnyAgentTool,
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import { buildComputerToolDescription } from "./computer-tool-guidance.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import { callGatewayTool, type GatewayCallOptions, readGatewayCallOptions } from "./gateway.js";
import {
  type EligibleNodeMessages,
  listNodes,
  type NodeListNode,
  resolveEligibleNodeFromList,
} from "./nodes-utils.js";

const COMPUTER_ACT_COMMAND = "computer.act";
const SCREEN_SNAPSHOT_COMMAND = "screen.snapshot";

// Reference frame width cap in pixels. The effective reference width is the
// smaller of this cap and the model's image sanitization limit, so a persisted
// screenshot that is replay-sanitized in later turns keeps the same pixel
// dimensions the coordinates were issued against (see resolveReferenceWidth).
const COMPUTER_REF_WIDTH = 1280;
const SCREENSHOT_QUALITY = 0.85;
// UI settle delay before the after-action screenshot.
const AFTER_ACTION_SCREENSHOT_DELAY_MS = 500;
const MAX_WAIT_SECONDS = 100;
const MAX_HOLD_SECONDS = 10;

const COMPUTER_TOOL_ACTIONS = COMPUTER_USE_V1_ACTION_NAMES;

type ComputerToolAction = ComputerUseV2ActionName;

const LOCAL_ACTIONS = new Set<ComputerUseV2ActionName>(["screenshot", "wait"]);
const EXECUTION_OWNED_ACTIONS = new Set<ComputerUseV2ActionName>([
  "browser_set_input_files",
  "browser_download",
  "get_recording_state",
  "start_recording",
  "stop_recording",
  "replay_trajectory",
]);
const INPUT_ACTIONS = new Set<ComputerUseV2ActionName>(
  COMPUTER_USE_V2_ACTION_NAMES.filter((action) => !LOCAL_ACTIONS.has(action)),
);

function isComputerActAction(action: ComputerToolAction): boolean {
  return INPUT_ACTIONS.has(action);
}

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

// Actions that accept an optional target coordinate (scroll at a point, press
// or release the button at a point). Keyboard actions never carry coordinates.
const COORDINATE_OPTIONAL_ACTIONS = new Set<ComputerToolAction>([
  "scroll",
  "left_mouse_down",
  "left_mouse_up",
]);

// Modifier keys ride the text field on pointer actions, mirroring the
// Anthropic computer_20251124 contract.
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

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

function isScrollDirection(value: string): value is (typeof SCROLL_DIRECTIONS)[number] {
  return SCROLL_DIRECTIONS.some((direction) => direction === value);
}

function createComputerToolSchema(actions: readonly ComputerUseV2ActionName[]) {
  return Type.Object({
    action: stringEnum(actions),
    ...gatewayCallOptionSchemaProperties(),
    node: Type.Optional(
      Type.String({
        description:
          "Paired node id or display name. Omit when exactly one connected computer-capable node exists.",
      }),
    ),
    // Codex accepts a single schema in array `items`, not tuple item arrays.
    // Fixed bounds preserve the coordinate-pair contract across runtimes.
    coordinate: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), {
        minItems: 2,
        maxItems: 2,
        description: "[x, y] target in pixels of the most recent screenshot.",
      }),
    ),
    startCoordinate: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), {
        minItems: 2,
        maxItems: 2,
        description: "left_click_drag: [x, y] drag origin in screenshot pixels.",
      }),
    ),
    destinationCoordinate: Type.Optional(
      Type.Array(Type.Number({ minimum: 0 }), {
        minItems: 2,
        maxItems: 2,
        description: "browser_pointer drag destination [x, y] in viewport CSS pixels.",
      }),
    ),
    text: Type.Optional(
      Type.String({
        description:
          'type: text to type; key/hold_key: key combo such as "cmd+shift+t" or "Return"; ' +
          'click/scroll actions: modifier keys to hold ("shift", "ctrl", "alt", "cmd").',
      }),
    ),
    scrollDirection: optionalStringEnum(SCROLL_DIRECTIONS),
    scrollAmount: optionalPositiveIntegerSchema({
      maximum: 100,
      description: "scroll: number of wheel ticks.",
    }),
    duration: optionalFiniteNumberSchema({
      minimum: 0,
      maximum: MAX_WAIT_SECONDS,
      description: `Seconds. hold_key: >0 to ${MAX_HOLD_SECONDS}; wait: 0 to ${MAX_WAIT_SECONDS}.`,
    }),
    screenIndex: optionalNonNegativeIntegerSchema(),
    frameId: Type.Optional(
      Type.String({
        description:
          "Coordinate actions: exact frame id returned by the most recent screenshot result.",
      }),
    ),
    windowRef: Type.Optional(
      Type.String({ description: "Opaque window reference from observation." }),
    ),
    browserRef: Type.Optional(
      Type.String({ description: "Opaque browser reference from get_browser_state." }),
    ),
    pageRef: Type.Optional(
      Type.String({ description: "Opaque browser page reference from get_browser_state." }),
    ),
    elementRef: Type.Optional(
      Type.String({ description: "Opaque accessibility element reference from observation." }),
    ),
    observationId: Type.Optional(
      Type.String({ description: "Observation id that issued window or element references." }),
    ),
    deliveryMode: optionalStringEnum(["background", "foreground"] as const),
    query: Type.Optional(Type.String()),
    depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
    maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    app: Type.Optional(Type.String()),
    value: Type.Optional(Type.String()),
    path: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 16 }),
    ),
    x1: Type.Optional(Type.Number({ minimum: 0 })),
    y1: Type.Optional(Type.Number({ minimum: 0 })),
    x2: Type.Optional(Type.Number({ minimum: 0 })),
    y2: Type.Optional(Type.Number({ minimum: 0 })),
    reason: optionalStringEnum([
      "ax_tree_pixel_mismatch",
      "background_delivery_failed",
      "foreground_ineffective",
      "no_window_target",
      "other",
    ] as const),
    snapshotFormat: optionalStringEnum(["dom_refs_v1", "semantic_v2"] as const),
    continuation: Type.Optional(Type.String()),
    includeScreenshot: Type.Optional(Type.Boolean()),
    profile: optionalStringEnum(["isolated_new", "isolated_named"] as const),
    profileName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    url: Type.Optional(Type.String()),
    inputRoute: optionalStringEnum(["trusted", "dom_event"] as const),
    mode: optionalStringEnum(["insert_text", "keystrokes"] as const),
    replace: Type.Optional(Type.Boolean()),
    dialogAction: optionalStringEnum(["inspect", "accept", "dismiss"] as const),
    dialogRef: Type.Optional(Type.String()),
    promptText: Type.Optional(Type.String()),
    resourceHandle: Type.Optional(
      Type.String({ description: "Opaque node-owned Computer Use resource handle." }),
    ),
    resourceHandles: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 }),
    ),
    recordVideo: Type.Optional(Type.Boolean()),
    delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    stopOnError: Type.Optional(Type.Boolean()),
    pointerAction: optionalStringEnum([
      "hover",
      "right_click",
      "double_click",
      "scroll",
      "drag",
    ] as const),
    destinationElementRef: Type.Optional(Type.String()),
    deltaX: Type.Optional(Type.Number()),
    deltaY: Type.Optional(Type.Number()),
  });
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
function buildComputerActParams(params: {
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

function isEligibleComputerNode(node: NodeListNode): boolean {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  // The tool loop authorizes coordinates against captured frames, so screenshot
  // support is a functional requirement rather than gating by platform name.
  return (
    node.connected === true &&
    commands.includes(COMPUTER_ACT_COMMAND) &&
    commands.includes(SCREEN_SNAPSHOT_COMMAND)
  );
}

const NOT_COMPUTER_CAPABLE_HINT =
  "enable Computer Control in the OpenClaw app and approve the pairing update";

const COMPUTER_NODE_MESSAGES: EligibleNodeMessages = {
  ineligibleExact: (query, eligibleIds) =>
    `node "${query}" is not computer-capable (needs a connected node advertising ${COMPUTER_ACT_COMMAND} and ${SCREEN_SNAPSHOT_COMMAND}; ${NOT_COMPUTER_CAPABLE_HINT}; ` +
    `eligible node ids: ${eligibleIds})`,
  nameResolveFailed: (reason, eligibleIds) =>
    `${reason} (eligible computer-capable node ids: ${eligibleIds})`,
  noneEligible: () =>
    `no connected computer-capable node (a node must advertise ${COMPUTER_ACT_COMMAND} and ${SCREEN_SNAPSHOT_COMMAND}; ${NOT_COMPUTER_CAPABLE_HINT})`,
  multipleEligible: (eligible) =>
    `multiple computer-capable nodes connected; pass node explicitly: ${eligible
      .map((node) => node.nodeId)
      .join(", ")}`,
};

async function resolveComputerNode(
  gatewayOpts: GatewayCallOptions,
  query?: string,
  signal?: AbortSignal,
): Promise<NodeListNode> {
  const nodes = await listNodes(gatewayOpts, signal);
  return resolveEligibleNodeFromList(nodes, query, isEligibleComputerNode, COMPUTER_NODE_MESSAGES);
}

type ScreenshotCapture = {
  base64: string;
  displayFrameId: string;
  mimeType: string;
  width?: number;
  height?: number;
};

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

function parseComputerActPayload(value: unknown): ComputerActResult {
  if (typeof value !== "string") {
    return parseComputerActResult(value);
  }
  try {
    return parseComputerActResult(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(COMPUTER_CONTRACT_MISMATCH)) {
      throw error;
    }
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: computer.act returned invalid JSON`, {
      cause: error,
    });
  }
}

// Model-visible ceiling for semantic elements per result. The wire schema
// admits far more for node-side fidelity; projecting them all would blow the
// model context budget, so the tool truncates and says so.
const MODEL_OBSERVATION_MAX_ELEMENTS = 200;

type ModelObservationProjection = NonNullable<ComputerActResult["observation"]> & {
  truncatedElements?: number;
};

function computerActResultText(action: ComputerUseV2ActionName, result: ComputerActResult): string {
  let observation: ModelObservationProjection | undefined = result.observation
    ? { ...result.observation, ...(result.observation.base64 ? { base64: "[image]" } : {}) }
    : undefined;
  if (observation?.elements && observation.elements.length > MODEL_OBSERVATION_MAX_ELEMENTS) {
    observation = {
      ...observation,
      elements: observation.elements.slice(0, MODEL_OBSERVATION_MAX_ELEMENTS),
      truncatedElements: observation.elements.length - MODEL_OBSERVATION_MAX_ELEMENTS,
    };
  }
  const details = result.details ? { ...result.details } : undefined;
  if (
    details &&
    Array.isArray(details.elements) &&
    details.elements.length > MODEL_OBSERVATION_MAX_ELEMENTS
  ) {
    const originalLength = details.elements.length;
    details.elements = details.elements.slice(0, MODEL_OBSERVATION_MAX_ELEMENTS);
    details.truncatedElements = originalLength - MODEL_OBSERVATION_MAX_ELEMENTS;
  }
  return JSON.stringify({
    action,
    ...result,
    ...(observation ? { observation } : {}),
    ...(details ? { details } : {}),
  });
}

async function invokeNodeCommand(params: {
  gatewayOpts: GatewayCallOptions;
  nodeId: string;
  command: string;
  commandParams: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const raw = await callGatewayTool<{ payload: unknown }>(
    "node.invoke",
    params.gatewayOpts,
    {
      nodeId: params.nodeId,
      command: params.command,
      params: params.commandParams,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
    },
    { signal: params.signal },
  );
  return raw && typeof raw === "object" && Object.hasOwn(raw, "payload")
    ? (raw as { payload: unknown }).payload
    : raw;
}

function computerActIdempotencyKey(params: { scope?: string; toolCallId: string }): string {
  const stableScope = params.scope?.trim();
  const stableCallId = params.toolCallId.trim();
  if (!stableScope || !stableCallId) {
    // A call id is only unique inside its model response. Without a stable run
    // scope and provider/fallback id, avoid collapsing unrelated actions.
    return crypto.randomUUID();
  }
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([stableScope, stableCallId, COMPUTER_ACT_COMMAND]))
    .digest("hex");
  return `computer.act:v1:${digest}`;
}

async function captureScreenshot(params: {
  gatewayOpts: GatewayCallOptions;
  nodeId: string;
  screenIndex: number;
  refWidth: number;
  executionId: string;
  signal?: AbortSignal;
}): Promise<ScreenshotCapture> {
  const commandParams: ScreenSnapshotParams = {
    executionId: params.executionId,
    screenIndex: params.screenIndex,
    maxWidth: params.refWidth,
    quality: SCREENSHOT_QUALITY,
    format: "jpeg",
  };
  const payload = await invokeNodeCommand({
    gatewayOpts: params.gatewayOpts,
    nodeId: params.nodeId,
    command: SCREEN_SNAPSHOT_COMMAND,
    commandParams,
    signal: params.signal,
  });
  const parsed = parseScreenSnapshotPayload(payload);
  if (!parsed.displayFrameId) {
    throw new Error(
      "screen.snapshot response missing displayFrameId; update the node app before computer use",
    );
  }
  return {
    base64: parsed.base64,
    displayFrameId: parsed.displayFrameId,
    mimeType: imageMimeFromFormat(parsed.format) ?? "image/jpeg",
    width: parsed.width,
    height: parsed.height,
  };
}

/**
 * The reference frame width both the screenshot and the coordinates use.
 * Capped at the model's image sanitization limit so a persisted screenshot that
 * is replay-sanitized in a later turn is not resized underneath the coordinate
 * frame the model is still issuing `refWidth` against.
 */
function resolveReferenceWidth(limits: { maxDimensionPx?: number }): number {
  const sanitizationLimit = limits.maxDimensionPx ?? DEFAULT_IMAGE_MAX_DIMENSION_PX;
  return Math.max(1, Math.min(COMPUTER_REF_WIDTH, sanitizationLimit));
}

const DANGEROUS_DENY_HINT = "blocked by gateway.nodes.commands.deny";
const PLATFORM_ALLOWLIST_HINT = "is not in the allowlist for platform";
const BUTTON_NOT_HELD_HINT = "left button is not held by computer control";
const DEFINITIVE_NODE_COMMAND_REASONS = new Set([
  "command required",
  "command not allowlisted",
  "command not declared by node",
  "node did not declare commands",
]);

export type ComputerContextEpoch = {
  value: number;
  /** Tool result whose screenshot currently authorizes coordinates. */
  frameToolCallId?: string;
  /** Digest of the exact sanitized image the model received for that result. */
  frameImageIdentity?: string;
};

function computerFrameImageIdentity(
  content: AgentToolResult<unknown>["content"],
): string | undefined {
  const images = content.filter(
    (block): block is Extract<(typeof content)[number], { type: "image" }> =>
      block.type === "image",
  );
  if (images.length !== 1) {
    return undefined;
  }
  const image = images.at(0);
  if (!image) {
    return undefined;
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([image.mimeType, image.data]))
    .digest("hex");
}

function invalidateComputerFrame(contextEpoch: ComputerContextEpoch): boolean {
  if (contextEpoch.frameToolCallId === undefined && contextEpoch.frameImageIdentity === undefined) {
    return false;
  }
  contextEpoch.value += 1;
  delete contextEpoch.frameToolCallId;
  delete contextEpoch.frameImageIdentity;
  return true;
}

/**
 * Invalidate screenshot coordinates when the final model context no longer
 * contains the image produced by the tracked computer tool result.
 */
export function invalidateComputerFrameIfMissing(params: {
  contextEpoch: ComputerContextEpoch;
  messages: AgentMessage[];
  imagesBlocked?: boolean;
}): boolean {
  const frameToolCallId = params.contextEpoch.frameToolCallId;
  if (frameToolCallId === undefined) {
    return invalidateComputerFrame(params.contextEpoch);
  }

  let frameImageIdentity: string | undefined;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index];
    if (
      message?.role !== "toolResult" ||
      message.toolName !== "computer" ||
      message.toolCallId !== frameToolCallId
    ) {
      continue;
    }
    frameImageIdentity = computerFrameImageIdentity(message.content);
    break;
  }

  if (
    !params.imagesBlocked &&
    frameImageIdentity !== undefined &&
    frameImageIdentity === params.contextEpoch.frameImageIdentity
  ) {
    return false;
  }
  return invalidateComputerFrame(params.contextEpoch);
}

function gatewayRequestDetails(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error) || err.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = (err as Error & { details?: unknown }).details;
  return isRecord(details) ? details : undefined;
}

function withComputerEnablementHint(err: unknown): Error {
  const message = formatErrorMessage(err);
  const reason = gatewayRequestDetails(err)?.reason;
  if (message.includes(DANGEROUS_DENY_HINT)) {
    return new Error(
      `${message} — remove ${COMPUTER_ACT_COMMAND} from gateway.nodes.commands.deny, then retry.`,
      { cause: err },
    );
  }
  if (
    reason === "command not allowlisted" ||
    reason === "command not declared by node" ||
    reason === "node did not declare commands" ||
    message.includes(PLATFORM_ALLOWLIST_HINT)
  ) {
    return new Error(`${message} — ${NOT_COMPUTER_CAPABLE_HINT}, then retry.`, { cause: err });
  }
  return err instanceof Error ? err : new Error(message);
}

function isDefinitiveComputerActRejection(err: unknown): boolean {
  const details = gatewayRequestDetails(err);
  return (
    details?.nodeCommandDispatched === false ||
    (typeof details?.reason === "string" && DEFINITIVE_NODE_COMMAND_REASONS.has(details.reason))
  );
}

function isButtonAlreadyReleasedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "GatewayClientRequestError" &&
    err.message.includes(BUTTON_NOT_HELD_HINT)
  );
}

function validateCapabilityBoundInput(params: {
  action: ComputerUseV2ActionName;
  input: Record<string, unknown>;
  nodeId: string;
  capabilities?: ComputerUseCapabilityDescriptor;
  observationState?: {
    nodeId: string;
    providerGeneration: string;
    observationId: string;
  };
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

export function createComputerTool(options?: {
  config?: OpenClawConfig;
  modelHasVision?: boolean;
  /** Stable run scope used to deduplicate a replayed model tool call on the node. */
  idempotencyScope?: string;
  /** Tracks whether the current screenshot pixels still reach model context. */
  contextEpoch?: ComputerContextEpoch;
  /** Attempt owner for deterministic provider-execution cleanup. */
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
}): AnyAgentTool {
  const executionId = crypto.randomUUID();
  const availableActions = (actions: readonly ComputerUseV2ActionName[]) =>
    options?.registerRunCleanup
      ? actions
      : actions.filter((action) => !EXECUTION_OWNED_ACTIONS.has(action));
  const configuredLimits = resolveImageSanitizationLimits(options?.config);
  const referenceWidth = resolveReferenceWidth(configuredLimits);
  const parameterSchema = createComputerToolSchema(availableActions(COMPUTER_TOOL_ACTIONS));
  let selectedCapabilities: ComputerUseCapabilityDescriptor | undefined;
  let selectedCapabilityNodeId: string | undefined;
  let observationState:
    | { nodeId: string; providerGeneration: string; observationId: string }
    | undefined;
  const replaceParameterSchema = (actions: readonly ComputerUseV2ActionName[]) => {
    const next = createComputerToolSchema(actions);
    for (const key of Object.keys(parameterSchema)) {
      Reflect.deleteProperty(parameterSchema, key);
    }
    Object.assign(parameterSchema, next);
  };
  const bindNodeCapabilities = (node: NodeListNode) => {
    const next = node.computerUse;
    const changed =
      selectedCapabilityNodeId !== node.nodeId ||
      selectedCapabilities?.provider.generation !== next?.provider.generation;
    selectedCapabilityNodeId = node.nodeId;
    selectedCapabilities = next;
    replaceParameterSchema(availableActions(next?.actions ?? COMPUTER_TOOL_ACTIONS));
    tool.description = buildComputerToolDescription(next);
    if (changed) {
      observationState = undefined;
    }
  };
  type ComputerTarget = { nodeId: string; screenIndex: number };
  type ComputerState =
    | { kind: "unbound" }
    | { kind: "target"; target: ComputerTarget }
    | {
        kind: "frame";
        target: ComputerTarget;
        id: string;
        displayFrameId: string;
        contextEpoch: number;
      };
  // Keep target affinity after pixels expire so cleanup input such as
  // left_mouse_up still reaches the machine/display that received the matching down.
  // Only the frame state authorizes coordinates from model-visible pixels.
  let computerState: ComputerState = { kind: "unbound" };
  const setComputerState = (
    next: ComputerState,
    frameToolCallId?: string,
    frameImageIdentity?: string,
  ) => {
    computerState = next;
    if (!options?.contextEpoch) {
      return;
    }
    if (
      next.kind === "frame" &&
      frameToolCallId !== undefined &&
      frameImageIdentity !== undefined
    ) {
      options.contextEpoch.frameToolCallId = frameToolCallId;
      options.contextEpoch.frameImageIdentity = frameImageIdentity;
    } else {
      delete options.contextEpoch.frameToolCallId;
      delete options.contextEpoch.frameImageIdentity;
    }
  };
  // A down timeout is ambiguous: input may have landed even when no response
  // arrived. Pin subsequent actions to that target until an up is confirmed,
  // so retargeting cannot strand a held button on another machine.
  let heldButtonTarget: ComputerTarget | undefined;
  // Serialize execute() per tool instance. This runtime can dispatch parallel
  // tool calls (some providers enable it by default), but desktop input and the
  // shared target/frame/button state must apply in model order, not completion
  // order: a click racing a type could type into the wrong app, and split
  // mouse down/move/up could interleave. Chaining preserves invocation order.
  let opQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = opQueue.then(fn, fn);
    opQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const executionNodes = new Map<string, GatewayCallOptions>();
  let disposePromise: Promise<void> | undefined;
  const dispose = async (reason: string): Promise<void> => {
    if (disposePromise) {
      return await disposePromise;
    }
    disposePromise = opQueue
      .catch(() => {})
      .then(async () => {
        const nodes = [...executionNodes.entries()];
        executionNodes.clear();
        await Promise.allSettled(
          nodes.map(async ([nodeId, gatewayOpts]) => {
            await invokeNodeCommand({
              gatewayOpts,
              nodeId,
              command: COMPUTER_ACT_COMMAND,
              commandParams: {
                action: "__close_execution",
                executionId,
                reason,
              },
              idempotencyKey: `computer.close:${executionId}:${nodeId}`,
            });
          }),
        );
      });
    return await disposePromise;
  };
  options?.registerRunCleanup?.(dispose);
  const tool: AnyAgentTool = {
    label: "Computer",
    name: "computer",
    // Catalog bridges serialize nested results as JSON, which strips the
    // model-visible screenshot block that coordinate actions depend on.
    catalogMode: "direct-only",
    executionMode: "sequential",
    description: buildComputerToolDescription(),
    parameters: parameterSchema,
    execute: (toolCallId, args, signal) =>
      serialize(async () => {
        signal?.throwIfAborted();
        const params = args as Record<string, unknown>;
        const action = readToolStringParam(params, "action", {
          required: true,
        }) as ComputerToolAction;
        const gatewayOpts = readGatewayCallOptions(params);
        const explicitNode = typeof params.node === "string" ? params.node : undefined;
        const explicitScreenIndex = (() => {
          if (params.screenIndex === undefined) {
            return undefined;
          }
          if (
            typeof params.screenIndex !== "number" ||
            !Number.isInteger(params.screenIndex) ||
            params.screenIndex < 0
          ) {
            throw new Error("screenIndex must be a non-negative integer");
          }
          return params.screenIndex;
        })();
        // Coordinate actions apply pixels from a specific screenshot, so they must
        // target the exact frame the model saw; keyboard actions and cursor-relative
        // scroll do not.
        const needsFrame =
          !params.windowRef &&
          !params.elementRef &&
          (COORDINATE_REQUIRED_ACTIONS.has(action) ||
            (COORDINATE_OPTIONAL_ACTIONS.has(action) && Array.isArray(params.coordinate)));
        const priorTarget = computerState.kind === "unbound" ? undefined : computerState.target;
        const implicitTarget = heldButtonTarget ?? priorTarget;
        // Bind the node to the established target: reuse the last machine unless the
        // caller names one, so cleanup input never drifts to a different desktop.
        let nodeId: string;
        if (explicitNode !== undefined) {
          const node = await resolveComputerNode(gatewayOpts, explicitNode, signal);
          nodeId = node.nodeId;
          bindNodeCapabilities(node);
        } else if (implicitTarget) {
          nodeId = implicitTarget.nodeId;
        } else {
          const node = await resolveComputerNode(gatewayOpts, undefined, signal);
          nodeId = node.nodeId;
          bindNodeCapabilities(node);
        }
        const capabilitiesForNode =
          selectedCapabilityNodeId === nodeId ? selectedCapabilities : undefined;
        executionNodes.set(nodeId, gatewayOpts);
        const advertisedActions = availableActions(
          capabilitiesForNode?.actions ?? COMPUTER_TOOL_ACTIONS,
        );
        if (!advertisedActions.includes(action)) {
          throw new Error(
            `${COMPUTER_CONTRACT_MISMATCH}: node ${nodeId} does not advertise action ${action}`,
          );
        }
        validateCapabilityBoundInput({
          action,
          input: params,
          nodeId,
          capabilities: capabilitiesForNode,
          observationState,
        });
        if (heldButtonTarget && nodeId !== heldButtonTarget.nodeId) {
          throw new Error(
            `computer: left button may still be held on node ${heldButtonTarget.nodeId}; ` +
              "release it before targeting another node",
          );
        }
        if (
          heldButtonTarget &&
          explicitScreenIndex !== undefined &&
          explicitScreenIndex !== heldButtonTarget.screenIndex
        ) {
          throw new Error(
            `computer: left button may still be held on screen ${heldButtonTarget.screenIndex}; ` +
              "release it before targeting another screen",
          );
        }
        // The observed frame is only a valid coordinate reference for its own node,
        // so switching to a different node drops the inherited display index and
        // requires a fresh screenshot of that node.
        const targetForNode = priorTarget?.nodeId === nodeId ? priorTarget : undefined;
        const frameForNode =
          computerState.kind === "frame" &&
          computerState.target.nodeId === nodeId &&
          computerState.contextEpoch === (options?.contextEpoch?.value ?? 0)
            ? computerState
            : undefined;
        // Fail closed rather than silently retargeting: a coordinate action with no
        // frame observed for this node this run (a fresh run, or a node switch) must
        // not fall back to display 0, nor apply another node's display index.
        if (needsFrame && !frameForNode) {
          throw new Error(
            "computer: no screenshot of this node has been taken yet, so there is no display frame to " +
              "target. Take a `screenshot` first (of this node) before issuing coordinate actions.",
          );
        }
        if (
          needsFrame &&
          explicitScreenIndex !== undefined &&
          explicitScreenIndex !== frameForNode?.target.screenIndex
        ) {
          throw new Error("computer: screenIndex does not match the most recent screenshot frame");
        }
        if (needsFrame && params.frameId !== frameForNode?.id) {
          throw new Error(
            "computer: frameId does not match the most recent screenshot result; take a new screenshot",
          );
        }
        const screenIndex =
          explicitScreenIndex ??
          frameForNode?.target.screenIndex ??
          heldButtonTarget?.screenIndex ??
          targetForNode?.screenIndex ??
          0;
        const target: ComputerTarget = { nodeId, screenIndex };

        const screenshotResult = async (
          capture: ScreenshotCapture,
          noteLines: string[],
        ): Promise<AgentToolResult<unknown>> => {
          const frameId = crypto.randomUUID();
          // Report the delivered dimensions, not the pre-sanitization capture size:
          // sanitizeToolResultImages caps the longest edge to referenceWidth, so a
          // portrait capture is scaled down. Advertising the original size would let
          // the model pick coordinates against a wider frame than it was shown.
          const longestEdge = Math.max(capture.width ?? 0, capture.height ?? 0);
          const frameScale = longestEdge > referenceWidth ? referenceWidth / longestEdge : 1;
          const deliveredWidth =
            capture.width != null ? Math.round(capture.width * frameScale) : undefined;
          const deliveredHeight =
            capture.height != null ? Math.round(capture.height * frameScale) : undefined;
          const dims =
            deliveredWidth && deliveredHeight
              ? `${deliveredWidth}x${deliveredHeight}`
              : "unknown size";
          const text = [
            ...noteLines,
            `screenshot ${dims} (screen ${screenIndex}, frameId ${frameId})`,
          ].join("\n");
          const content: AgentToolResult<unknown>["content"] = [{ type: "text", text }];
          if (options?.modelHasVision !== false) {
            content.push({ type: "image", data: capture.base64, mimeType: capture.mimeType });
          } else {
            content.push({
              type: "text",
              text: "[model has no vision; screenshot omitted — use a vision-capable model for computer use]",
            });
          }
          // Cap the delivered screenshot's longest edge to the reference width so
          // the coordinate frame is stable across turns. Replay-sanitization in
          // later turns caps the longest edge to the configured limit, which is
          // >= referenceWidth, so it is a no-op and the node maps coordinates
          // against this same width for both portrait and landscape captures. A
          // portrait frame (height > referenceWidth) is uniformly scaled down here,
          // matching OpenClawComputerInputGeometry.capturedWidth on the node.
          // media.outbound=false keeps desktop pixels model-only (#44759).
          const result = await sanitizeToolResultImages(
            {
              content,
              details: {
                node: nodeId,
                action,
                width: deliveredWidth,
                height: deliveredHeight,
                screenIndex,
                frameId,
                refWidth: referenceWidth,
                media: { outbound: false },
              },
            },
            `computer:${action}`,
            {
              maxDimensionPx: referenceWidth,
            },
          );
          const deliveredImageIdentity = computerFrameImageIdentity(result.content);
          if (options?.modelHasVision !== false && deliveredImageIdentity) {
            // Only a model-visible, successfully sanitized image may authorize
            // coordinates. A token also prevents same-turn batched clicks from
            // targeting a screenshot the model has not observed yet.
            setComputerState(
              {
                kind: "frame",
                target,
                id: frameId,
                displayFrameId: capture.displayFrameId,
                contextEpoch: options?.contextEpoch?.value ?? 0,
              },
              toolCallId,
              deliveredImageIdentity,
            );
          } else {
            setComputerState({ kind: "target", target });
          }
          return result;
        };

        const actEnvelopeResult = async (
          result: ComputerActResult,
        ): Promise<AgentToolResult<unknown>> => {
          const observation = result.observation;
          if (observation?.observationId && capabilitiesForNode) {
            observationState = {
              nodeId,
              providerGeneration: capabilitiesForNode.provider.generation,
              observationId: observation.observationId,
            };
          }
          const content: AgentToolResult<unknown>["content"] = [
            { type: "text", text: computerActResultText(action, result) },
          ];
          if (observation?.base64 && options?.modelHasVision !== false) {
            content.push({
              type: "image",
              data: observation.base64,
              mimeType: imageMimeFromFormat(observation.format ?? "png") ?? "image/png",
            });
          }
          setComputerState({ kind: "target", target });
          return await sanitizeToolResultImages(
            {
              content,
              details: {
                node: nodeId,
                action,
                screenIndex,
                result,
                media: { outbound: false },
              },
            },
            `computer:${action}`,
            { maxDimensionPx: referenceWidth },
          );
        };

        switch (action) {
          case "screenshot": {
            setComputerState({ kind: "target", target });
            const capture = await captureScreenshot({
              gatewayOpts,
              nodeId,
              screenIndex,
              refWidth: referenceWidth,
              executionId,
              signal,
            });
            return await screenshotResult(capture, []);
          }
          case "wait": {
            const seconds =
              readFiniteNumberParam(params, "duration", {
                min: 0,
                max: MAX_WAIT_SECONDS,
                message: `duration must be 0-${MAX_WAIT_SECONDS} seconds for wait`,
              }) ?? 1;
            setComputerState({ kind: "target", target });
            await sleep(Math.round(seconds * 1000), signal);
            const capture = await captureScreenshot({
              gatewayOpts,
              nodeId,
              screenIndex,
              refWidth: referenceWidth,
              executionId,
              signal,
            });
            return await screenshotResult(capture, [`waited ${seconds}s`]);
          }
          default:
            break;
        }

        if (!isComputerActAction(action)) {
          throw new Error(`Unknown action: ${action}`);
        }
        const wireParams = buildComputerActParams({
          action,
          input: params,
          executionId,
          screenIndex,
          displayFrameId: frameForNode?.displayFrameId,
          refWidth: referenceWidth,
        });
        // hold_key blocks node-side for its duration; give the invoke headroom.
        const durationMs =
          "durationMs" in wireParams && typeof wireParams.durationMs === "number"
            ? wireParams.durationMs
            : undefined;
        const invokeTimeoutMs = durationMs ? durationMs + 10_000 : undefined;
        // Node/display resolution is asynchronous. Recheck before claiming
        // affinity so pre-dispatch cancellation cannot leave a phantom hold.
        signal?.throwIfAborted();
        // Any input attempt invalidates the pre-action pixels, including timeouts
        // and failures where the gateway cannot prove whether input landed. Keep
        // affinity so a later coordinate-free cleanup action reaches this target.
        setComputerState({ kind: "target", target });
        if (action === "left_mouse_down") {
          heldButtonTarget = target;
        }
        let actResult: ComputerActResult;
        try {
          actResult = parseComputerActPayload(
            await invokeNodeCommand({
              gatewayOpts,
              nodeId,
              command: COMPUTER_ACT_COMMAND,
              commandParams: { ...wireParams },
              timeoutMs: invokeTimeoutMs,
              idempotencyKey: computerActIdempotencyKey({
                scope: options?.idempotencyScope,
                toolCallId,
              }),
              signal,
            }),
          );
        } catch (err) {
          if (action === "left_mouse_down" && isDefinitiveComputerActRejection(err)) {
            // Request validation and gateway policy denials happen before
            // dispatch. UNAVAILABLE may arrive after input landed, so it keeps
            // affinity until a matching release is confirmed.
            heldButtonTarget = undefined;
          }
          if (action === "left_mouse_up" && isButtonAlreadyReleasedError(err)) {
            // Lifecycle cleanup or the node watchdog may have released it first.
            // Treat cleanup as idempotent without posting an unmatched mouse-up.
            heldButtonTarget = undefined;
            actResult = { ok: true };
          } else {
            throw withComputerEnablementHint(err);
          }
        }
        if (action === "left_mouse_up") {
          heldButtonTarget = undefined;
        }
        if (actResult.observation || READ_ONLY_COMPUTER_ACT_ACTIONS.has(action)) {
          return await actEnvelopeResult(actResult);
        }
        await sleep(AFTER_ACTION_SCREENSHOT_DELAY_MS, signal);
        try {
          const capture = await captureScreenshot({
            gatewayOpts,
            nodeId,
            screenIndex,
            refWidth: referenceWidth,
            executionId,
            signal,
          });
          return await screenshotResult(capture, [computerActResultText(action, actResult)]);
        } catch (err) {
          signal?.throwIfAborted();
          // Input landed; a failed follow-up screenshot should not fail the action.
          return {
            content: [
              {
                type: "text",
                text: `${computerActResultText(action, actResult)}\nfollow-up screenshot failed: ${formatErrorMessage(err)}`,
              },
            ],
            details: { node: nodeId, action, screenIndex, result: actResult },
          };
        }
      }),
  };
  return tool;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

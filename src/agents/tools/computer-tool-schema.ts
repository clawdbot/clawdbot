import { Type } from "typebox";
import {
  COMPUTER_USE_V1_ACTION_NAMES,
  type ComputerUseV2ActionName,
} from "../../plugins/computer-use-contract.js";
import {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../schema/typebox.js";
import { MAX_HOLD_SECONDS, MAX_WAIT_SECONDS } from "./computer-tool-shared.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";

export const COMPUTER_TOOL_ACTIONS = COMPUTER_USE_V1_ACTION_NAMES;

const EXECUTION_OWNED_ACTIONS = new Set<ComputerUseV2ActionName>([
  "browser_set_input_files",
  "browser_download",
  "get_recording_state",
  "start_recording",
  "stop_recording",
  "replay_trajectory",
]);

export function availableComputerActions(
  actions: readonly ComputerUseV2ActionName[],
  hasCleanupOwner: boolean,
): readonly ComputerUseV2ActionName[] {
  return hasCleanupOwner
    ? actions
    : actions.filter((action) => !EXECUTION_OWNED_ACTIONS.has(action));
}

export function createComputerToolSchema(
  actions: readonly ComputerUseV2ActionName[],
  targetScope: "paired" | "session" = "paired",
) {
  return Type.Object({
    action: stringEnum(actions),
    ...(targetScope === "paired"
      ? {
          ...gatewayCallOptionSchemaProperties(),
          node: Type.Optional(
            Type.String({
              description:
                "Paired node id or display name. Omit when exactly one connected computer-capable node exists.",
            }),
          ),
        }
      : {}),
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
    scrollDirection: optionalStringEnum(["up", "down", "left", "right"] as const),
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

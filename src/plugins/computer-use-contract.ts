import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandContext,
} from "./types.node-host.js";

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

export const COMPUTER_USE_V1_ACTION_NAMES = COMPUTER_USE_V2_ACTION_NAMES.slice(0, 15);

export const COMPUTER_ACT_V1_ACTION_NAMES = COMPUTER_USE_V2_ACTION_NAMES.slice(1, 14);

export const COMPUTER_USE_CONTRACT_ONLY_ACTION_NAMES = [
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
  "get_recording_state",
  "start_recording",
  "stop_recording",
  "replay_trajectory",
] as const satisfies readonly ComputerUseV2ActionName[];

export const COMPUTER_CONTRACT_MISMATCH = "COMPUTER_CONTRACT_MISMATCH";
export const COMPUTER_STALE_OBSERVATION = "COMPUTER_STALE_OBSERVATION";

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
const DELIVERY_MODES = ["background", "foreground"] as const;
const ESCALATION_REASONS = [
  "ax_tree_pixel_mismatch",
  "background_delivery_failed",
  "foreground_ineffective",
  "no_window_target",
  "other",
] as const;

const optionalScreenFields = {
  screenIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  refWidth: Type.Optional(Type.Integer({ minimum: 1 })),
};

const optionalReferenceFields = {
  windowRef: Type.Optional(Type.String({ minLength: 1 })),
  elementRef: Type.Optional(Type.String({ minLength: 1 })),
  observationId: Type.Optional(Type.String({ minLength: 1 })),
  deliveryMode: Type.Optional(Type.Enum(DELIVERY_MODES, { type: "string" })),
};

function actionObject<const Properties extends object>(
  actions: readonly string[],
  properties: Properties,
) {
  return Type.Object(
    {
      action: Type.Enum(actions, { type: "string" }),
      ...properties,
    },
    { additionalProperties: false },
  );
}

const ComputerActV1ParamsSchema = Type.Union([
  actionObject(
    ["left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move"],
    {
      displayFrameId: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number({ minimum: 0 })),
      y: Type.Optional(Type.Number({ minimum: 0 })),
      modifiers: Type.Optional(Type.String()),
      ...optionalScreenFields,
      ...optionalReferenceFields,
    },
  ),
  actionObject(["left_click_drag"], {
    displayFrameId: Type.Optional(Type.String()),
    x: Type.Optional(Type.Number({ minimum: 0 })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    fromX: Type.Optional(Type.Number({ minimum: 0 })),
    fromY: Type.Optional(Type.Number({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    ...optionalScreenFields,
    ...optionalReferenceFields,
  }),
  actionObject(["left_mouse_down", "left_mouse_up"], {
    displayFrameId: Type.Optional(Type.String()),
    x: Type.Optional(Type.Number({ minimum: 0 })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    modifiers: Type.Optional(Type.String()),
    ...optionalScreenFields,
    ...optionalReferenceFields,
  }),
  actionObject(["scroll"], {
    displayFrameId: Type.Optional(Type.String()),
    x: Type.Optional(Type.Number({ minimum: 0 })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    modifiers: Type.Optional(Type.String()),
    scrollDirection: Type.Optional(Type.Enum(SCROLL_DIRECTIONS, { type: "string" })),
    scrollAmount: Type.Optional(Type.Integer({ minimum: 1 })),
    ...optionalScreenFields,
    ...optionalReferenceFields,
  }),
  actionObject(["type"], {
    text: Type.Optional(Type.String()),
    ...optionalScreenFields,
    ...optionalReferenceFields,
  }),
  actionObject(["key"], {
    keys: Type.Optional(Type.String()),
    ...optionalScreenFields,
    ...optionalReferenceFields,
  }),
  actionObject(["hold_key"], {
    keys: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    ...optionalScreenFields,
    ...optionalReferenceFields,
  }),
]);

/** Canonical inner payload accepted by the `computer.act` node command. */
export const ComputerActParamsSchema = Type.Union([
  ...ComputerActV1ParamsSchema.anyOf,
  actionObject(["list_apps", "list_windows", "get_cursor_position"], {}),
  actionObject(["get_accessibility_tree"], {
    windowRef: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String()),
    depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
    maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  }),
  actionObject(["get_window_state"], {
    windowRef: Type.String({ minLength: 1 }),
    query: Type.Optional(Type.String()),
    depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
    maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  }),
  actionObject(["launch_app", "kill_app"], {
    app: Type.String({ minLength: 1 }),
  }),
  actionObject(["bring_to_front"], {
    windowRef: Type.String({ minLength: 1 }),
  }),
  actionObject(["set_value"], {
    windowRef: Type.String({ minLength: 1 }),
    elementRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    value: Type.String(),
    deliveryMode: Type.Optional(Type.Enum(DELIVERY_MODES, { type: "string" })),
  }),
  actionObject(["invoke_menu"], {
    windowRef: Type.String({ minLength: 1 }),
    path: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      minItems: 1,
      maxItems: 16,
    }),
    deliveryMode: Type.Optional(Type.Enum(DELIVERY_MODES, { type: "string" })),
  }),
  actionObject(["zoom"], {
    windowRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    x1: Type.Number({ minimum: 0 }),
    y1: Type.Number({ minimum: 0 }),
    x2: Type.Number({ minimum: 0 }),
    y2: Type.Number({ minimum: 0 }),
  }),
  actionObject(["escalate_scope"], {
    reason: Type.Enum(ESCALATION_REASONS, { type: "string" }),
  }),
]);

// Hard result ceilings live inline on the schema (elements maxItems, details
// maxProperties); tests read them from the schema so there is one source of truth.
const COMPUTER_ACT_RESULT_MAX_ELEMENTS = 2_000;
const COMPUTER_ACT_RESULT_MAX_DETAIL_KEYS = 64;

const ComputerBoundsSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 0 }),
    height: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const ComputerObservationSchema = Type.Object(
  {
    kind: Type.Enum(["window", "screen"] as const, { type: "string" }),
    base64: Type.Optional(Type.String()),
    format: Type.Optional(Type.Enum(["jpeg", "png"] as const, { type: "string" })),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    observationId: Type.Optional(Type.String({ minLength: 1 })),
    elements: Type.Optional(
      Type.Array(
        Type.Object(
          {
            elementRef: Type.String({ minLength: 1 }),
            role: Type.String({ minLength: 1 }),
            label: Type.Optional(Type.String()),
            value: Type.Optional(Type.String()),
            bounds: ComputerBoundsSchema,
          },
          { additionalProperties: false },
        ),
        { maxItems: COMPUTER_ACT_RESULT_MAX_ELEMENTS },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ComputerActResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    effect: Type.Optional(
      Type.Enum(["confirmed", "unverifiable", "suspected_noop"] as const, {
        type: "string",
      }),
    ),
    observation: Type.Optional(ComputerObservationSchema),
    escalation: Type.Optional(
      Type.Object(
        {
          recommended: Type.Enum(["window-pixel", "foreground", "desktop"] as const, {
            type: "string",
          }),
          reasonCode: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    details: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown(), {
        maxProperties: COMPUTER_ACT_RESULT_MAX_DETAIL_KEYS,
      }),
    ),
  },
  { additionalProperties: false },
);

export const ComputerUseCapabilityDescriptorSchema = Type.Object(
  {
    contractVersion: Type.Literal(2),
    provider: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        label: Type.String({ minLength: 1, maxLength: 256 }),
        generation: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
    actions: Type.Array(Type.Enum(COMPUTER_USE_V2_ACTION_NAMES, { type: "string" }), {
      maxItems: COMPUTER_USE_V2_ACTION_NAMES.length,
      uniqueItems: true,
    }),
    targets: Type.Array(Type.Enum(["screen", "window", "element", "browser"] as const), {
      maxItems: 4,
      uniqueItems: true,
    }),
    deliveryModes: Type.Array(Type.Enum(DELIVERY_MODES, { type: "string" }), {
      maxItems: DELIVERY_MODES.length,
      uniqueItems: true,
    }),
    observations: Type.Array(
      Type.Enum(["image", "accessibility", "browser"] as const, { type: "string" }),
      { maxItems: 3, uniqueItems: true },
    ),
    features: Type.Object(
      {
        recording: Type.Boolean(),
        agentCursor: Type.Boolean(),
        multiDisplay: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Canonical inner payload accepted by the `screen.snapshot` node command. */
export const ScreenSnapshotParamsSchema = Type.Object(
  {
    screenIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    maxWidth: Type.Optional(Type.Integer({ minimum: 1 })),
    quality: Type.Optional(Type.Number()),
    format: Type.Optional(Type.Enum(["jpeg", "png"], { type: "string" })),
  },
  { additionalProperties: false },
);

/** Canonical inner payload returned by the `screen.snapshot` node command. */
export const ScreenSnapshotResultSchema = Type.Object({
  format: Type.Enum(["jpeg", "png"], { type: "string" }),
  base64: Type.String({ minLength: 1 }),
  displayFrameId: Type.Optional(Type.String()),
  screenIndex: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  capturedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type ComputerActParams = Static<typeof ComputerActParamsSchema>;
export type ComputerActResult = Static<typeof ComputerActResultSchema>;
export type ComputerUseCapabilityDescriptor = Static<typeof ComputerUseCapabilityDescriptorSchema>;
export type ScreenSnapshotParams = Static<typeof ScreenSnapshotParamsSchema>;
export type ScreenSnapshotResult = Static<typeof ScreenSnapshotResultSchema>;

type ComputerUseValidator<Value> = (value: unknown) => value is Value;

/** Compile one Computer Use wire schema into a reusable type-guard validator. */
export function compileComputerUseValidator<const Schema extends TSchema>(
  schema: Schema,
): ComputerUseValidator<Static<Schema>> {
  const validator = Compile(schema);
  return (value: unknown): value is Static<Schema> => validator.Check(value);
}

const validateComputerActParams = compileComputerUseValidator(ComputerActParamsSchema);
const validateComputerActResult = compileComputerUseValidator(ComputerActResultSchema);
const validateComputerUseCapabilityDescriptor = compileComputerUseValidator(
  ComputerUseCapabilityDescriptorSchema,
);
const validateScreenSnapshotParams = compileComputerUseValidator(ScreenSnapshotParamsSchema);
const validateScreenSnapshotResult = compileComputerUseValidator(ScreenSnapshotResultSchema);

function parseParamsJSON<Value>(
  paramsJSON: string | null | undefined,
  validate: ComputerUseValidator<Value>,
): Value {
  let value: unknown;
  try {
    value = JSON.parse(paramsJSON ?? "{}");
  } catch {
    throw new Error("COMPUTER_INVALID_REQUEST: params must be valid JSON");
  }
  if (!validate(value)) {
    throw new Error("COMPUTER_INVALID_REQUEST: invalid params");
  }
  return value;
}

export function parseComputerActParamsJSON(
  paramsJSON: string | null | undefined,
): ComputerActParams {
  return parseParamsJSON(paramsJSON, validateComputerActParams);
}

export function parseScreenSnapshotParamsJSON(
  paramsJSON: string | null | undefined,
): ScreenSnapshotParams {
  return parseParamsJSON(paramsJSON, validateScreenSnapshotParams);
}

/** Validate one provider result envelope. */
export function parseComputerActResult(value: unknown): ComputerActResult {
  if (!validateComputerActResult(value)) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: invalid computer.act result`);
  }
  return value;
}

/** Validate one bounded Computer Use declaration carried by a node connect. */
export function parseComputerUseCapabilityDescriptor(
  value: unknown,
): ComputerUseCapabilityDescriptor {
  if (!validateComputerUseCapabilityDescriptor(value)) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: invalid capability descriptor`);
  }
  return value;
}

/** Validate and project a `screen.snapshot` result without retaining unknown fields. */
export function parseScreenSnapshotResult(value: unknown): ScreenSnapshotResult {
  if (!validateScreenSnapshotResult(value)) {
    throw new Error("invalid screen.snapshot payload");
  }
  return {
    format: value.format,
    base64: value.base64,
    ...(value.displayFrameId ? { displayFrameId: value.displayFrameId } : {}),
    ...(value.screenIndex !== undefined ? { screenIndex: value.screenIndex } : {}),
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.capturedAtMs !== undefined ? { capturedAtMs: value.capturedAtMs } : {}),
  };
}

type ComputerUseExecution = {
  snapshot(paramsJSON: string | null | undefined, signal?: AbortSignal): Promise<string>;
  act(paramsJSON: string | null | undefined, signal?: AbortSignal): Promise<string>;
  close(reason: string): Promise<void>;
};

export type ComputerUseProvider = {
  id: string;
  label: string;
  capabilities(): ComputerUseCapabilityDescriptor;
  isAvailable(): boolean;
  watchAvailability?: (
    context: OpenClawPluginNodeHostCommandAvailabilityContext,
    onChange: () => void,
  ) => (() => void) | void;
  openExecution(context: { sessionKey?: string }): Promise<ComputerUseExecution>;
};

// Structural registration surface built from leaf node-host types only: importing
// the full plugin API type here creates an import cycle through the gateway
// server-method types that consume this contract.
type ComputerUseRegistrationApi = {
  registerNodeHostCommand(command: OpenClawPluginNodeHostCommand): void;
};

/** Register the canonical node-host command pair for one node-local provider. */
export function registerComputerUseProvider(
  api: ComputerUseRegistrationApi,
  provider: ComputerUseProvider,
): void {
  let executionPromise: Promise<ComputerUseExecution> | undefined;

  const getExecution = (context?: OpenClawPluginNodeHostCommandContext) => {
    if (!executionPromise) {
      const opened = provider.openExecution(
        context?.sessionKey ? { sessionKey: context.sessionKey } : {},
      );
      // A failed open must not wedge the provider behind a cached rejection;
      // the next command call retries openExecution instead.
      opened.catch(() => {
        if (executionPromise === opened) {
          executionPromise = undefined;
        }
      });
      executionPromise = opened;
    }
    return executionPromise;
  };
  const closeExecution = async (reason: string) => {
    const current = executionPromise;
    executionPromise = undefined;
    if (current) {
      await (await current).close(reason);
    }
  };

  api.registerNodeHostCommand({
    command: "screen.snapshot",
    cap: "screen",
    dangerous: false,
    isAvailable: () => provider.isAvailable(),
    watchAvailability: (context, onChange) => {
      const stopWatching = provider.watchAvailability?.(context, onChange);
      return () => {
        stopWatching?.();
        void closeExecution("node-host-stop");
      };
    },
    handle: async (paramsJSON, _io, context) =>
      await (await getExecution(context)).snapshot(paramsJSON, context?.signal),
  });
  api.registerNodeHostCommand({
    command: "computer.act",
    cap: "computer",
    dangerous: true,
    computerUse: () => provider.capabilities(),
    isAvailable: () => provider.isAvailable(),
    handle: async (paramsJSON, _io, context) =>
      await (await getExecution(context)).act(paramsJSON, context?.signal),
  });
  // The provider plugin must also register its dangerous `computer.act` invoke
  // policy with the full plugin API. Forgetting it fails closed: the Gateway
  // rejects dangerous plugin commands that lack a registered policy.
}

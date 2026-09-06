import { randomUUID } from "node:crypto";
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
const COMPUTER_RESOURCE_HANDLE_PATTERN =
  "^openclaw:computer-resource:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const COMPUTER_EXECUTION_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

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
      executionId: Type.Optional(Type.String({ pattern: COMPUTER_EXECUTION_ID_PATTERN })),
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
  actionObject(["get_browser_state"], {
    windowRef: Type.String({ minLength: 1 }),
  }),
  actionObject(["get_browser_state"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    snapshotFormat: Type.Optional(
      Type.Enum(["dom_refs_v1", "semantic_v2"] as const, { type: "string" }),
    ),
    elementRef: Type.Optional(Type.String({ minLength: 1 })),
    observationId: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String()),
    continuation: Type.Optional(Type.String({ minLength: 1 })),
    includeScreenshot: Type.Optional(Type.Boolean()),
  }),
  actionObject(["browser_prepare"], {
    windowRef: Type.String({ minLength: 1 }),
    profile: Type.Optional(
      Type.Enum(["isolated_new", "isolated_named"] as const, { type: "string" }),
    ),
    profileName: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
    ),
  }),
  actionObject(["browser_navigate"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    url: Type.String({ minLength: 1 }),
  }),
  actionObject(["browser_click"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    elementRef: Type.Optional(Type.String({ minLength: 1 })),
    x: Type.Optional(Type.Number({ minimum: 0 })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    inputRoute: Type.Optional(Type.Enum(["trusted", "dom_event"] as const, { type: "string" })),
  }),
  actionObject(["browser_type"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    elementRef: Type.String({ minLength: 1 }),
    text: Type.String(),
    mode: Type.Optional(Type.Enum(["insert_text", "keystrokes"] as const, { type: "string" })),
    replace: Type.Optional(Type.Boolean()),
  }),
  actionObject(["browser_dialog"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    dialogAction: Type.Literal("inspect"),
  }),
  actionObject(["browser_dialog"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    dialogAction: Type.Literal("accept"),
    dialogRef: Type.String({ minLength: 1 }),
    promptText: Type.Optional(Type.String()),
    deliveryMode: Type.Optional(Type.Enum(DELIVERY_MODES, { type: "string" })),
  }),
  actionObject(["browser_dialog"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    dialogAction: Type.Literal("dismiss"),
    dialogRef: Type.String({ minLength: 1 }),
    deliveryMode: Type.Optional(Type.Enum(DELIVERY_MODES, { type: "string" })),
  }),
  actionObject(["browser_set_input_files"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    elementRef: Type.String({ minLength: 1 }),
    resourceHandles: Type.Array(Type.String({ pattern: COMPUTER_RESOURCE_HANDLE_PATTERN }), {
      minItems: 1,
      maxItems: 32,
    }),
  }),
  actionObject(["browser_download"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    elementRef: Type.String({ minLength: 1 }),
  }),
  actionObject(["browser_pointer"], {
    browserRef: Type.String({ minLength: 1 }),
    pageRef: Type.String({ minLength: 1 }),
    observationId: Type.String({ minLength: 1 }),
    pointerAction: Type.Enum(["hover", "right_click", "double_click", "scroll", "drag"] as const, {
      type: "string",
    }),
    inputRoute: Type.Optional(Type.Enum(["trusted", "dom_event"] as const, { type: "string" })),
    elementRef: Type.Optional(Type.String({ minLength: 1 })),
    x: Type.Optional(Type.Number({ minimum: 0 })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    destinationElementRef: Type.Optional(Type.String({ minLength: 1 })),
    toX: Type.Optional(Type.Number({ minimum: 0 })),
    toY: Type.Optional(Type.Number({ minimum: 0 })),
    deltaX: Type.Optional(Type.Number()),
    deltaY: Type.Optional(Type.Number()),
  }),
  actionObject(["escalate_scope"], {
    reason: Type.Enum(ESCALATION_REASONS, { type: "string" }),
  }),
  actionObject(["get_recording_state", "stop_recording"], {}),
  actionObject(["start_recording"], {
    recordVideo: Type.Optional(Type.Boolean()),
  }),
  actionObject(["replay_trajectory"], {
    resourceHandle: Type.String({ pattern: COMPUTER_RESOURCE_HANDLE_PATTERN }),
    delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    stopOnError: Type.Optional(Type.Boolean()),
  }),
]);

// Bound provider-controlled result collections before they cross the node-host wire contract.
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
    kind: Type.Enum(["window", "screen", "browser"] as const, { type: "string" }),
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
    executionId: Type.Optional(Type.String({ pattern: COMPUTER_EXECUTION_ID_PATTERN })),
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
  prepare?: (context: OpenClawPluginNodeHostCommandAvailabilityContext) => Promise<void> | void;
  watchAvailability?: (
    context: OpenClawPluginNodeHostCommandAvailabilityContext,
    onChange: () => void,
  ) => (() => void) | void;
  openExecution(context: {
    executionId: string;
    sessionKey?: string;
  }): Promise<ComputerUseExecution>;
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
  let execution: { id: string; promise: Promise<ComputerUseExecution> } | undefined;
  let closingPromise: Promise<void> = Promise.resolve();

  const executionEnvelopeFromParams = (paramsJSON: string | null | undefined) => {
    let value: unknown;
    try {
      value = JSON.parse(paramsJSON ?? "{}");
    } catch {
      throw new Error("COMPUTER_INVALID_REQUEST: params must be valid JSON");
    }
    const executionId =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { executionId?: unknown }).executionId
        : undefined;
    if (executionId === undefined) {
      return { executionId: undefined, value };
    }
    if (
      typeof executionId !== "string" ||
      !new RegExp(COMPUTER_EXECUTION_ID_PATTERN, "u").test(executionId)
    ) {
      throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
    }
    return { executionId, value };
  };
  const getExecution = async (
    paramsJSON: string | null | undefined,
    context?: OpenClawPluginNodeHostCommandContext,
  ) => {
    const { executionId } = executionEnvelopeFromParams(paramsJSON);
    if (!executionId) {
      throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
    }
    await closingPromise;
    if (execution && execution.id !== executionId) {
      throw new Error("COMPUTER_HOST_BUSY: another provider execution owns this computer");
    }
    if (!execution) {
      const opened = provider.openExecution(
        context?.sessionKey ? { executionId, sessionKey: context.sessionKey } : { executionId },
      );
      // A failed open must not wedge the provider behind a cached rejection;
      // the next command call retries openExecution instead.
      opened.catch(() => {
        if (execution?.promise === opened) {
          execution = undefined;
        }
      });
      execution = { id: executionId, promise: opened };
    }
    return execution.promise;
  };
  const closeExecution = async (executionId: string | undefined, reason: string) => {
    await closingPromise;
    const current = execution;
    if (!current || (executionId !== undefined && current.id !== executionId)) {
      return;
    }
    execution = undefined;
    if (current) {
      const close = current.promise.then(async (opened) => await opened.close(reason));
      closingPromise = close.catch(() => {});
      await close;
    }
  };

  api.registerNodeHostCommand({
    command: "screen.snapshot",
    cap: "screen",
    dangerous: false,
    prepare: (context) => provider.prepare?.(context),
    isAvailable: () => provider.isAvailable(),
    watchAvailability: (context, onChange) => {
      const stopWatching = provider.watchAvailability?.(context, onChange);
      return () => {
        stopWatching?.();
        void closeExecution(undefined, "node-host-stop");
      };
    },
    onDisconnect: async () => await closeExecution(undefined, "gateway-disconnect"),
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON);
      if (envelope.executionId) {
        return await (
          await getExecution(paramsJSON, context)
        ).snapshot(paramsJSON, context?.signal);
      }
      const executionId = randomUUID();
      const opened = await provider.openExecution(
        context?.sessionKey ? { executionId, sessionKey: context.sessionKey } : { executionId },
      );
      try {
        return await opened.snapshot(paramsJSON, context?.signal);
      } finally {
        await opened.close("snapshot-complete");
      }
    },
  });
  api.registerNodeHostCommand({
    command: "computer.act",
    cap: "computer",
    dangerous: true,
    computerUse: () => provider.capabilities(),
    isAvailable: () => provider.isAvailable(),
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON);
      if (!envelope.executionId) {
        throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
      }
      if (
        envelope.value &&
        typeof envelope.value === "object" &&
        !Array.isArray(envelope.value) &&
        (envelope.value as { action?: unknown }).action === "__close_execution"
      ) {
        const reason = (envelope.value as { reason?: unknown }).reason;
        await closeExecution(
          envelope.executionId,
          typeof reason === "string" && reason.trim() ? reason.slice(0, 64) : "completion",
        );
        return JSON.stringify({ ok: true });
      }
      return await (await getExecution(paramsJSON, context)).act(paramsJSON, context?.signal);
    },
  });
  // The provider plugin must also register its dangerous `computer.act` invoke
  // policy with the full plugin API. Forgetting it fails closed: the Gateway
  // rejects dangerous plugin commands that lack a registered policy.
}

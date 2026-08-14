import { type Static, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { OpenClawPluginApi } from "./plugin-api.types.js";
import type {
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandContext,
} from "./types.node-host.js";

const COMPUTER_ACT_ACTIONS = [
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
] as const;

const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

/** Canonical inner payload accepted by the `computer.act` node command. */
export const ComputerActParamsSchema = Type.Object(
  {
    action: Type.Enum(COMPUTER_ACT_ACTIONS, { type: "string" }),
    displayFrameId: Type.Optional(Type.String()),
    x: Type.Optional(Type.Number({ minimum: 0 })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    fromX: Type.Optional(Type.Number({ minimum: 0 })),
    fromY: Type.Optional(Type.Number({ minimum: 0 })),
    text: Type.Optional(Type.String()),
    keys: Type.Optional(Type.String()),
    modifiers: Type.Optional(Type.String()),
    scrollDirection: Type.Optional(Type.Enum(SCROLL_DIRECTIONS, { type: "string" })),
    scrollAmount: Type.Optional(Type.Integer({ minimum: 1 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    screenIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    refWidth: Type.Optional(Type.Integer({ minimum: 1 })),
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
  isAvailable(): boolean;
  watchAvailability?: (
    context: OpenClawPluginNodeHostCommandAvailabilityContext,
    onChange: () => void,
  ) => (() => void) | void;
  openExecution(context: { sessionKey?: string }): Promise<ComputerUseExecution>;
};

type ComputerUseRegistrationApi = Pick<
  OpenClawPluginApi,
  "registerNodeHostCommand" | "registerNodeInvokePolicy"
>;

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
    isAvailable: () => provider.isAvailable(),
    handle: async (paramsJSON, _io, context) =>
      await (await getExecution(context)).act(paramsJSON, context?.signal),
  });
  // Preserve the existing dangerous-command policy: allowlisting happens
  // first, then this final Gateway guard forwards the armed invocation.
  api.registerNodeInvokePolicy({
    commands: ["computer.act"],
    dangerous: true,
    handle: async (context) => await context.invokeNode(),
  });
}

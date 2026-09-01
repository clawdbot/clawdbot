import { Type, type TSchema } from "typebox";
import { closedObject } from "./closed-object.js";

// ECMAScript Date's inclusive timestamp limit. Keep public schedule numbers
// inside the range the scheduler can represent and serialize.
export const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
export const CronDateTimestampMsSchema = Type.Integer({
  minimum: 0,
  maximum: MAX_DATE_TIMESTAMP_MS,
});

/** Builds create/patch payload variants while preserving per-call field optionality. */
export function cronAgentTurnPayloadSchema<
  TMessage extends TSchema,
  TModel extends TSchema,
  TFallbacks extends TSchema,
  TToolsAllow extends TSchema,
  TThinking extends TSchema,
>(params: {
  message: TMessage;
  model: TModel;
  fallbacks: TFallbacks;
  toolsAllow: TToolsAllow;
  thinking: TThinking;
}) {
  return closedObject({
    kind: Type.Literal("agentTurn"),
    message: params.message,
    model: Type.Optional(params.model),
    fallbacks: Type.Optional(params.fallbacks),
    thinking: Type.Optional(params.thinking),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
    lightContext: Type.Optional(Type.Boolean()),
    toolsAllow: Type.Optional(params.toolsAllow),
    // Server-managed marker for auto-stamped defaults; persisted so CLI cron
    // runs can drop only the cap that was never user-explicit.
    toolsAllowIsDefault: Type.Optional(Type.Boolean()),
  });
}

/** Builds command payload variants while preserving create/patch argv optionality. */
export function cronCommandPayloadSchema<
  TArgv extends TSchema,
  TToolsAllow extends TSchema,
>(params: { argv: TArgv; toolsAllow: TToolsAllow }) {
  return closedObject({
    kind: Type.Literal("command"),
    argv: params.argv,
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    input: Type.Optional(Type.String()),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    noOutputTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    outputMaxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    toolsAllow: Type.Optional(params.toolsAllow),
    toolsAllowIsDefault: Type.Optional(Type.Boolean()),
  });
}

export function cronScriptPayloadSchema<
  TScript extends TSchema,
  TToolsAllow extends TSchema,
>(params: { script: TScript; toolsAllow: TToolsAllow }) {
  return closedObject({
    kind: Type.Literal("script"),
    script: params.script,
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
    toolBudget: Type.Optional(Type.Integer({ minimum: 1 })),
    toolsAllow: Type.Optional(params.toolsAllow),
    toolsAllowIsDefault: Type.Optional(Type.Boolean()),
  });
}

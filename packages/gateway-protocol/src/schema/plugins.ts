// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Plugin control-surface protocol schemas.
 *
 * These payloads let the gateway expose plugin-provided UI actions without
 * baking plugin-specific payload shapes into the core protocol.
 */
/** Arbitrary plugin-owned JSON payload carried opaquely through the gateway. */
export const PluginJsonValueSchema = Type.Unknown();

/** Descriptor for one plugin-provided control UI action or surface. */
export const PluginControlUiDescriptorSchema = Type.Object(
  {
    id: NonEmptyString,
    pluginId: NonEmptyString,
    pluginName: Type.Optional(NonEmptyString),
    surface: Type.Union([
      Type.Literal("session"),
      Type.Literal("tool"),
      Type.Literal("run"),
      Type.Literal("settings"),
    ]),
    label: NonEmptyString,
    description: Type.Optional(Type.String()),
    placement: Type.Optional(Type.String()),
    schema: Type.Optional(PluginJsonValueSchema),
    requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Empty request payload for listing plugin UI descriptors. */
export const PluginsUiDescriptorsParamsSchema = Type.Object({}, { additionalProperties: false });

/** Response payload containing all plugin UI descriptors visible to the client. */
export const PluginsUiDescriptorsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    descriptors: Type.Array(PluginControlUiDescriptorSchema),
  },
  { additionalProperties: false },
);

/** Request payload for invoking one plugin-owned session action. */
export const PluginsSessionActionParamsSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    actionId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    payload: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Successful plugin action result, optionally continuing the agent turn. */
export const PluginsSessionActionSuccessResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    result: Type.Optional(PluginJsonValueSchema),
    continueAgent: Type.Optional(Type.Boolean()),
    reply: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Failed plugin action result with plugin-owned detail payload. */
export const PluginsSessionActionFailureResultSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String(),
    code: Type.Optional(Type.String()),
    details: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Discriminated plugin action result returned to gateway clients. */
export const PluginsSessionActionResultSchema = Type.Union([
  PluginsSessionActionSuccessResultSchema,
  PluginsSessionActionFailureResultSchema,
]);

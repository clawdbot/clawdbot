import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const PluginJsonValueSchema = Type.Unknown();

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

export const PluginsUiDescriptorsParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsUiDescriptorsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    descriptors: Type.Array(PluginControlUiDescriptorSchema),
  },
  { additionalProperties: false },
);

export const PluginsSessionActionParamsSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    actionId: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    payload: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

export const PluginsSessionActionSuccessResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    result: Type.Optional(PluginJsonValueSchema),
    continueAgent: Type.Optional(Type.Boolean()),
    reply: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

export const PluginsSessionActionFailureResultSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String(),
    code: Type.Optional(Type.String()),
    details: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

export const PluginsSessionActionResultSchema = Type.Union([
  PluginsSessionActionSuccessResultSchema,
  PluginsSessionActionFailureResultSchema,
]);

/**
 * Agent-facing Canvas tool schema and allowed action/format enums.
 */
import {
  optionalFiniteNumberSchema,
  optionalPositiveIntegerSchema,
  stringEnum,
} from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

/** Agent tool actions supported by the Canvas plugin. */
const CANVAS_ACTIONS = ["present", "hide", "navigate"] as const;

/** TypeBox schema for the model-facing Canvas tool arguments. */
export const CanvasToolSchema = Type.Object({
  action: stringEnum(CANVAS_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: optionalPositiveIntegerSchema(),
  node: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  x: optionalFiniteNumberSchema(),
  y: optionalFiniteNumberSchema(),
  width: optionalFiniteNumberSchema(),
  height: optionalFiniteNumberSchema(),
  url: Type.Optional(Type.String()),
});

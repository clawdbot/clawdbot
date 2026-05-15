import { Type } from "typebox";

export const CANVAS_ACTIONS = [
  "present",
  "hide",
  "navigate",
  "eval",
  "snapshot",
  "a2ui_push",
  "a2ui_reset",
] as const;

export const CANVAS_SNAPSHOT_FORMATS = ["png", "jpg", "jpeg"] as const;

function stringEnum<T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
  });
}

export const CanvasToolSchema = Type.Object({
  action: stringEnum(CANVAS_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  url: Type.Optional(Type.String()),
  javaScript: Type.Optional(Type.String()),
  outputFormat: Type.Optional(stringEnum(CANVAS_SNAPSHOT_FORMATS)),
  maxWidth: Type.Optional(Type.Number()),
  quality: Type.Optional(Type.Number()),
  delayMs: Type.Optional(Type.Number()),
  jsonl: Type.Optional(Type.String()),
  jsonlPath: Type.Optional(Type.String()),
});

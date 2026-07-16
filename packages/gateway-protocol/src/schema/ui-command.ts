import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const UiSplitCommandSchema = closedObject({
  kind: Type.Literal("split"),
  direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
  sessionKey: NonEmptyString,
});
export const UiClosePaneCommandSchema = closedObject({
  kind: Type.Literal("close-pane"),
  sessionKey: NonEmptyString,
});
export const UiFocusCommandSchema = closedObject({
  kind: Type.Literal("focus"),
  sessionKey: NonEmptyString,
});
export const UiSidebarCommandSchema = closedObject({
  kind: Type.Literal("sidebar"),
  visible: Type.Boolean(),
});
export const UiPanelCommandSchema = closedObject({
  kind: Type.Literal("panel"),
  panel: Type.Union([Type.Literal("terminal"), Type.Literal("browser")]),
  open: Type.Boolean(),
  dock: Type.Optional(Type.Union([Type.Literal("bottom"), Type.Literal("right")])),
});
export const UiNavigateCommandSchema = closedObject({
  kind: Type.Literal("navigate"),
  sessionKey: NonEmptyString,
});

export const UiCommandSchema = Type.Union([
  UiSplitCommandSchema,
  UiClosePaneCommandSchema,
  UiFocusCommandSchema,
  UiSidebarCommandSchema,
  UiPanelCommandSchema,
  UiNavigateCommandSchema,
]);
export type UiCommand = Static<typeof UiCommandSchema>;

export const UiCommandParamsSchema = closedObject({
  command: UiCommandSchema,
  sessionKey: Type.Optional(NonEmptyString),
});
export type UiCommandParams = Static<typeof UiCommandParamsSchema>;

export const UiCommandResultSchema = closedObject({ ok: Type.Boolean() });
export type UiCommandResult = Static<typeof UiCommandResultSchema>;

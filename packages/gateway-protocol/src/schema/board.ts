import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const BoardTabIdSchema = Type.String({ pattern: "^[a-z0-9-]{1,40}$" });
export const BoardWidgetNameSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
});
export const BoardWidgetPluginKindSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$",
});
export const BoardWidgetPluginPropsSchema = Type.Record(Type.String(), Type.Unknown());
export const BoardChatDockSchema = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
  Type.Literal("bottom"),
  Type.Literal("hidden"),
]);
export const BoardSizeSchema = Type.Union([
  Type.Literal("sm"),
  Type.Literal("md"),
  Type.Literal("lg"),
  Type.Literal("xl"),
  Type.Literal("full"),
]);
export const BoardWidgetPresentationSchema = Type.Union([
  Type.Literal("card"),
  Type.Literal("full-bleed"),
  Type.Literal("frameless"),
]);
export const BoardWidgetHeightModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("fixed"),
]);

export const BOARD_CRON_JOB_ID_MAX_LENGTH = 256;
export const BOARD_CRON_TRIGGER_PREFIX = "cron.trigger:";
export const BOARD_WIDGET_TOOL_MAX_LENGTH =
  BOARD_CRON_TRIGGER_PREFIX.length + BOARD_CRON_JOB_ID_MAX_LENGTH;
export const BOARD_DATA_BINDING_ID_MAX_LENGTH = 64;

export const BoardTabSchema = closedObject({
  tabId: BoardTabIdSchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  position: Type.Integer({ minimum: 0 }),
  chatDock: BoardChatDockSchema,
});
export type BoardTab = Static<typeof BoardTabSchema>;

export const BoardWidgetDeclaredSchema = closedObject({
  netOrigins: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: BOARD_WIDGET_TOOL_MAX_LENGTH }), {
      maxItems: 64,
    }),
  ),
});
export type BoardWidgetDeclared = Static<typeof BoardWidgetDeclaredSchema>;

export const BoardWidgetSchema = closedObject({
  name: BoardWidgetNameSchema,
  tabId: BoardTabIdSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  contentKind: Type.Union([Type.Literal("html"), Type.Literal("mcp-app"), Type.Literal("plugin")]),
  pluginKind: Type.Optional(BoardWidgetPluginKindSchema),
  props: Type.Optional(BoardWidgetPluginPropsSchema),
  presentation: Type.Optional(BoardWidgetPresentationSchema),
  heightMode: Type.Optional(BoardWidgetHeightModeSchema),
  sizeW: Type.Integer({ minimum: 1, maximum: 12 }),
  sizeH: Type.Integer({ minimum: 1, maximum: 20 }),
  position: Type.Integer({ minimum: 0 }),
  grantState: Type.Union([
    Type.Literal("none"),
    Type.Literal("pending"),
    Type.Literal("granted"),
    Type.Literal("rejected"),
  ]),
  revision: Type.Integer({ minimum: 1 }),
  instanceId: Type.Optional(NonEmptyString),
  declaredSummary: Type.Optional(Type.Array(Type.String())),
  declared: Type.Optional(BoardWidgetDeclaredSchema),
  frameUrl: Type.Optional(Type.String()),
  viewTicket: Type.Optional(Type.String()),
  viewTicketTtlMs: Type.Optional(Type.Integer({ minimum: 1 })),
  viewGeneration: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
  sandboxUrl: Type.Optional(Type.String()),
  sandboxPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  sandboxOrigin: Type.Optional(Type.String()),
});
export type BoardWidget = Static<typeof BoardWidgetSchema>;

export const BoardSnapshotSchema = closedObject({
  sessionKey: NonEmptyString,
  revision: Type.Integer({ minimum: 0 }),
  tabs: Type.Array(BoardTabSchema),
  widgets: Type.Array(BoardWidgetSchema),
});
export type BoardSnapshot = Static<typeof BoardSnapshotSchema>;

export const BoardTabCreateOpSchema = closedObject({
  kind: Type.Literal("tab_create"),
  tabId: BoardTabIdSchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  chatDock: Type.Optional(BoardChatDockSchema),
});
export const BoardTabUpdateOpSchema = closedObject({
  kind: Type.Literal("tab_update"),
  tabId: BoardTabIdSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  chatDock: Type.Optional(BoardChatDockSchema),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const BoardTabDeleteOpSchema = closedObject({
  kind: Type.Literal("tab_delete"),
  tabId: BoardTabIdSchema,
});
export const BoardTabsReorderOpSchema = closedObject({
  kind: Type.Literal("tabs_reorder"),
  tabIds: Type.Array(BoardTabIdSchema),
});
export const BoardWidgetMoveOpSchema = closedObject({
  kind: Type.Literal("widget_move"),
  name: BoardWidgetNameSchema,
  tabId: Type.Optional(BoardTabIdSchema),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
  after: Type.Optional(BoardWidgetNameSchema),
});
export const BoardWidgetResizeOpSchema = closedObject({
  kind: Type.Literal("widget_resize"),
  name: BoardWidgetNameSchema,
  sizeW: Type.Integer(),
  sizeH: Type.Integer(),
  heightMode: Type.Optional(BoardWidgetHeightModeSchema),
});
export const BoardWidgetRemoveOpSchema = closedObject({
  kind: Type.Literal("widget_remove"),
  name: BoardWidgetNameSchema,
});
export const BoardOpSchema = Type.Union([
  BoardTabCreateOpSchema,
  BoardTabUpdateOpSchema,
  BoardTabDeleteOpSchema,
  BoardTabsReorderOpSchema,
  BoardWidgetMoveOpSchema,
  BoardWidgetResizeOpSchema,
  BoardWidgetRemoveOpSchema,
]);
export type BoardOp = Static<typeof BoardOpSchema>;

export const BoardGetParamsSchema = closedObject({ sessionKey: NonEmptyString });
export type BoardGetParams = Static<typeof BoardGetParamsSchema>;

export const BoardUpdateParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  ops: Type.Array(BoardOpSchema),
});
export type BoardUpdateParams = Static<typeof BoardUpdateParamsSchema>;

export const BoardMcpAppDescriptorSchema = closedObject({
  serverName: NonEmptyString,
  toolName: NonEmptyString,
  uiResourceUri: NonEmptyString,
  toolCallId: NonEmptyString,
});
export type BoardMcpAppDescriptor = Static<typeof BoardMcpAppDescriptorSchema>;

export const BoardWidgetHtmlContentSchema = closedObject({
  kind: Type.Literal("html"),
  html: Type.String({ maxLength: 262_144 }),
});
export const BoardWidgetMcpAppContentSchema = closedObject({
  kind: Type.Literal("mcp-app"),
  descriptor: BoardMcpAppDescriptorSchema,
});
export const BoardWidgetMcpAppPutContentSchema = closedObject({
  kind: Type.Literal("mcp-app"),
  viewId: NonEmptyString,
});
export const BoardWidgetPluginContentSchema = closedObject({
  kind: Type.Literal("plugin"),
  pluginKind: BoardWidgetPluginKindSchema,
  props: Type.Optional(BoardWidgetPluginPropsSchema),
});
export const BoardWidgetContentSchema = Type.Union([
  BoardWidgetHtmlContentSchema,
  BoardWidgetMcpAppContentSchema,
  BoardWidgetPluginContentSchema,
]);
export type BoardWidgetContent = Static<typeof BoardWidgetContentSchema>;
export type BoardWidgetMaterializedContent =
  | Static<typeof BoardWidgetHtmlContentSchema>
  | (Static<typeof BoardWidgetMcpAppContentSchema> & { interactive: boolean })
  | Static<typeof BoardWidgetPluginContentSchema>;

export const BoardCanvasDocumentSourceSchema = closedObject({
  kind: Type.Literal("canvas-doc"),
  docId: NonEmptyString,
});
export type BoardCanvasDocumentSource = Static<typeof BoardCanvasDocumentSourceSchema>;

export const BoardWidgetPutContentSchema = Type.Union([
  BoardWidgetHtmlContentSchema,
  BoardWidgetMcpAppPutContentSchema,
  BoardWidgetPluginContentSchema,
  BoardCanvasDocumentSourceSchema,
]);
export type BoardWidgetPutContent = Static<typeof BoardWidgetPutContentSchema>;

export const BoardWidgetPutParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  name: BoardWidgetNameSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  content: BoardWidgetPutContentSchema,
  presentation: Type.Optional(BoardWidgetPresentationSchema),
  heightMode: Type.Optional(BoardWidgetHeightModeSchema),
  placement: Type.Optional(
    closedObject({
      tabId: Type.Optional(BoardTabIdSchema),
      size: Type.Optional(BoardSizeSchema),
      after: Type.Optional(BoardWidgetNameSchema),
    }),
  ),
  declared: Type.Optional(BoardWidgetDeclaredSchema),
});
export type BoardWidgetPutParams = Static<typeof BoardWidgetPutParamsSchema>;
/** Materialized input accepted by the board store after gateway source resolution. */
export type BoardWidgetMaterializedPutParams = Omit<BoardWidgetPutParams, "content"> & {
  content: BoardWidgetMaterializedContent;
};

export const BoardWidgetGrantParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  name: BoardWidgetNameSchema,
  decision: Type.Union([Type.Literal("granted"), Type.Literal("rejected")]),
  revision: Type.Integer({ minimum: 1 }),
  instanceId: NonEmptyString,
});
export type BoardWidgetGrantParams = Static<typeof BoardWidgetGrantParamsSchema>;

export const BoardWidgetAppViewParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  name: BoardWidgetNameSchema,
  revision: Type.Integer({ minimum: 1 }),
  instanceId: NonEmptyString,
});
export type BoardWidgetAppViewParams = Static<typeof BoardWidgetAppViewParamsSchema>;

export const BoardWidgetAppViewResultSchema = closedObject({
  viewId: NonEmptyString,
  expiresAtMs: Type.Integer({ minimum: 0 }),
});
export type BoardWidgetAppViewResult = Static<typeof BoardWidgetAppViewResultSchema>;

export const BoardViewTicketSchema = Type.String({ minLength: 1, maxLength: 2048 });

export const BoardLegacyEventParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  widget: BoardWidgetNameSchema,
  payload: Type.Unknown(),
});
export const BoardTicketEventParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  payload: Type.Unknown(),
});
export const BoardEventParamsSchema = Type.Union([
  BoardLegacyEventParamsSchema,
  BoardTicketEventParamsSchema,
]);
export type BoardEventParams = Static<typeof BoardEventParamsSchema>;

export const BoardPromptAuthorizeParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
});
export type BoardPromptAuthorizeParams = Static<typeof BoardPromptAuthorizeParamsSchema>;

export const BoardDataReadParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  bindingId: Type.String({ minLength: 1, maxLength: BOARD_DATA_BINDING_ID_MAX_LENGTH }),
  params: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Unknown(), {
      maxProperties: 64,
    }),
  ),
});
export type BoardDataReadParams = Static<typeof BoardDataReadParamsSchema>;

export const BoardCronActionParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  action: Type.Literal("cron.trigger"),
  jobId: Type.String({ minLength: 1, maxLength: BOARD_CRON_JOB_ID_MAX_LENGTH }),
});
export const BoardPluginActionParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  action: Type.String({ minLength: 1, maxLength: BOARD_WIDGET_TOOL_MAX_LENGTH }),
  params: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Unknown(), {
      maxProperties: 64,
    }),
  ),
});
export const BoardActionParamsSchema = Type.Union([
  BoardCronActionParamsSchema,
  BoardPluginActionParamsSchema,
]);
export type BoardActionParams = Static<typeof BoardActionParamsSchema>;

export const BoardChangedEventSchema = closedObject({
  sessionKey: NonEmptyString,
  revision: Type.Integer({ minimum: 0 }),
  widget: Type.Optional(BoardWidgetNameSchema),
});
export type BoardChangedEvent = Static<typeof BoardChangedEventSchema>;

export const BoardFocusTabCommandSchema = closedObject({
  kind: Type.Literal("focus_tab"),
  tabId: BoardTabIdSchema,
});
export const BoardSetChatDockCommandSchema = closedObject({
  kind: Type.Literal("set_chat_dock"),
  dock: BoardChatDockSchema,
});
export const BoardCommandSchema = Type.Union([
  BoardFocusTabCommandSchema,
  BoardSetChatDockCommandSchema,
]);
export type BoardCommand = Static<typeof BoardCommandSchema>;

export const BoardCommandEventSchema = closedObject({
  sessionKey: NonEmptyString,
  command: BoardCommandSchema,
});
export type BoardCommandEvent = Static<typeof BoardCommandEventSchema>;

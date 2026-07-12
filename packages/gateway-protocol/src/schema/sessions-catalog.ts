import type { Static } from "typebox";
import { Type } from "typebox";
import { PluginJsonValueSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";

const SessionCatalogErrorSchema = Type.Object(
  { code: NonEmptyString, message: NonEmptyString },
  { additionalProperties: false },
);

export const SessionCatalogCapabilitiesSchema = Type.Object(
  { continueSession: Type.Boolean(), archive: Type.Boolean() },
  { additionalProperties: false },
);

export const SessionCatalogDescriptorSchema = Type.Object(
  { id: NonEmptyString, label: NonEmptyString, capabilities: SessionCatalogCapabilitiesSchema },
  { additionalProperties: false },
);

export const SessionCatalogSessionSchema = Type.Object(
  {
    threadId: NonEmptyString,
    name: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    status: NonEmptyString,
    createdAt: Type.Optional(Type.Number()),
    updatedAt: Type.Optional(Type.Number()),
    recencyAt: Type.Optional(Type.Number()),
    source: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
    cliVersion: Type.Optional(Type.String()),
    gitBranch: Type.Optional(Type.String()),
    archived: Type.Boolean(),
    openClawSessionKey: Type.Optional(NonEmptyString),
    canContinue: Type.Boolean(),
    canArchive: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SessionCatalogHostSchema = Type.Object(
  {
    hostId: NonEmptyString,
    label: NonEmptyString,
    kind: Type.Union([Type.Literal("gateway"), Type.Literal("node")]),
    connected: Type.Boolean(),
    nodeId: Type.Optional(NonEmptyString),
    sessions: Type.Array(SessionCatalogSessionSchema),
    nextCursor: Type.Optional(Type.String()),
    error: Type.Optional(SessionCatalogErrorSchema),
  },
  { additionalProperties: false },
);

export const SessionCatalogSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    capabilities: SessionCatalogCapabilitiesSchema,
    hosts: Type.Array(SessionCatalogHostSchema),
    error: Type.Optional(SessionCatalogErrorSchema),
  },
  { additionalProperties: false },
);

const SessionsCatalogListCommonProperties = {
  search: Type.Optional(Type.String()),
  limitPerHost: Type.Optional(Type.Integer({ minimum: 1 })),
  hostIds: Type.Optional(Type.Array(NonEmptyString)),
};

export const SessionsCatalogListParamsSchema = Type.Union([
  Type.Object(
    { catalogId: Type.Optional(NonEmptyString), ...SessionsCatalogListCommonProperties },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      catalogId: NonEmptyString,
      cursors: Type.Record(NonEmptyString, Type.String()),
      ...SessionsCatalogListCommonProperties,
    },
    { additionalProperties: false },
  ),
]);

export const SessionsCatalogListResultSchema = Type.Object(
  { catalogs: Type.Array(SessionCatalogSchema) },
  { additionalProperties: false },
);

export const SessionCatalogTranscriptItemSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    type: Type.Union([
      Type.Literal("userMessage"),
      Type.Literal("agentMessage"),
      Type.Literal("reasoning"),
      Type.Literal("toolCall"),
      Type.Literal("toolResult"),
      Type.Literal("other"),
    ]),
    text: Type.Optional(Type.String()),
    timestamp: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    raw: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

export const SessionsCatalogReadParamsSchema = Type.Object(
  {
    catalogId: NonEmptyString,
    hostId: NonEmptyString,
    threadId: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionsCatalogReadResultSchema = Type.Object(
  {
    hostId: NonEmptyString,
    label: Type.Optional(Type.String()),
    threadId: NonEmptyString,
    items: Type.Array(SessionCatalogTranscriptItemSchema),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SessionsCatalogContinueParamsSchema = Type.Object(
  { catalogId: NonEmptyString, hostId: NonEmptyString, threadId: NonEmptyString },
  { additionalProperties: false },
);

export const SessionsCatalogContinueResultSchema = Type.Object(
  { sessionKey: NonEmptyString },
  { additionalProperties: false },
);

export const SessionsCatalogArchiveParamsSchema = Type.Object(
  {
    catalogId: NonEmptyString,
    hostId: NonEmptyString,
    threadId: NonEmptyString,
    confirmNoOtherRunner: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const SessionsCatalogArchiveResultSchema = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false },
);

export type SessionCatalogCapabilities = Static<typeof SessionCatalogCapabilitiesSchema>;
export type SessionCatalogDescriptor = Static<typeof SessionCatalogDescriptorSchema>;
export type SessionCatalogSession = Static<typeof SessionCatalogSessionSchema>;
export type SessionCatalogHost = Static<typeof SessionCatalogHostSchema>;
export type SessionCatalog = Static<typeof SessionCatalogSchema>;
export type SessionsCatalogListParams = Static<typeof SessionsCatalogListParamsSchema>;
export type SessionsCatalogListResult = Static<typeof SessionsCatalogListResultSchema>;
export type SessionCatalogTranscriptItem = Static<typeof SessionCatalogTranscriptItemSchema>;
export type SessionsCatalogReadParams = Static<typeof SessionsCatalogReadParamsSchema>;
export type SessionsCatalogReadResult = Static<typeof SessionsCatalogReadResultSchema>;
export type SessionsCatalogContinueParams = Static<typeof SessionsCatalogContinueParamsSchema>;
export type SessionsCatalogContinueResult = Static<typeof SessionsCatalogContinueResultSchema>;
export type SessionsCatalogArchiveParams = Static<typeof SessionsCatalogArchiveParamsSchema>;
export type SessionsCatalogArchiveResult = Static<typeof SessionsCatalogArchiveResultSchema>;

import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { PluginJsonValueSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";
import { SessionCreatedActorSchema } from "./sessions-row.js";

const SessionCatalogErrorSchema = closedObject({ code: NonEmptyString, message: NonEmptyString });

export const SessionCatalogLocatorSchema = closedObject({
  catalogId: NonEmptyString,
  hostId: NonEmptyString,
  threadId: NonEmptyString,
});

export const SessionCatalogCapabilitiesSchema = closedObject({
  continueSession: Type.Boolean(),
  archive: Type.Boolean(),
  createSession: Type.Optional(closedObject({ model: NonEmptyString })),
  openTerminal: Type.Optional(Type.Boolean()),
});

export const SessionCatalogDescriptorSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  capabilities: SessionCatalogCapabilitiesSchema,
});

export const SessionCatalogPullRequestSummarySchema = closedObject({
  numbers: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  }),
  state: Type.Union([
    Type.Literal("open"),
    Type.Literal("draft"),
    Type.Literal("merged"),
    Type.Literal("closed"),
  ]),
});

export const SessionCatalogSessionSchema = closedObject({
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
  customGroup: Type.Optional(Type.String()),
  pullRequest: Type.Optional(SessionCatalogPullRequestSummarySchema),
  archived: Type.Boolean(),
  sessionKey: Type.Optional(NonEmptyString),
  createdActor: Type.Optional(SessionCreatedActorSchema),
  canContinue: Type.Boolean(),
  canArchive: Type.Boolean(),
  canOpenTerminal: Type.Optional(Type.Boolean()),
});

export const SessionCatalogHostSchema = closedObject({
  hostId: NonEmptyString,
  label: NonEmptyString,
  kind: Type.Union([Type.Literal("gateway"), Type.Literal("node")]),
  connected: Type.Boolean(),
  nodeId: Type.Optional(NonEmptyString),
  sessions: Type.Array(SessionCatalogSessionSchema),
  nextCursor: Type.Optional(Type.String()),
  error: Type.Optional(SessionCatalogErrorSchema),
});

export const SessionCatalogSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  capabilities: SessionCatalogCapabilitiesSchema,
  hosts: Type.Array(SessionCatalogHostSchema),
  error: Type.Optional(SessionCatalogErrorSchema),
});

const SessionsCatalogListCommonProperties = {
  agentId: Type.Optional(NonEmptyString),
  progressId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  search: Type.Optional(Type.String()),
  limitPerHost: Type.Optional(Type.Integer({ minimum: 1 })),
  hostIds: Type.Optional(Type.Array(NonEmptyString)),
};

export const SessionsCatalogListParamsSchema = closedObject({
  catalogId: Type.Optional(NonEmptyString),
  cursors: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  ...SessionsCatalogListCommonProperties,
});

export const SessionsCatalogListResultSchema = closedObject({
  catalogs: Type.Array(SessionCatalogSchema),
});

const SessionsCatalogHostEventCatalogSchema = closedObject({
  ...SessionCatalogSchema.properties,
  hosts: Type.Array(SessionCatalogHostSchema, { minItems: 1, maxItems: 1 }),
});

export const SessionsCatalogHostEventSchema = closedObject({
  progressId: Type.String({ minLength: 1, maxLength: 128 }),
  agentId: NonEmptyString,
  catalog: SessionsCatalogHostEventCatalogSchema,
});

export const SessionCatalogTranscriptItemSchema = closedObject({
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
});

export const SessionsCatalogReadParamsSchema = closedObject({
  ...SessionCatalogLocatorSchema.properties,
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  cursor: Type.Optional(Type.String()),
});

export const SessionsCatalogReadResultSchema = closedObject({
  hostId: NonEmptyString,
  label: Type.Optional(Type.String()),
  threadId: NonEmptyString,
  items: Type.Array(SessionCatalogTranscriptItemSchema),
  nextCursor: Type.Optional(Type.String()),
});

export const SessionsCatalogContinueParamsSchema = closedObject({
  ...SessionCatalogLocatorSchema.properties,
});

export const SessionsCatalogContinueResultSchema = closedObject({ sessionKey: NonEmptyString });

export const SessionsCatalogArchiveParamsSchema = closedObject({
  ...SessionCatalogLocatorSchema.properties,
  confirmNoOtherRunner: Type.Literal(true),
});

export const SessionsCatalogArchiveResultSchema = closedObject({ ok: Type.Literal(true) });

export type SessionCatalogCapabilities = Static<typeof SessionCatalogCapabilitiesSchema>;
export type SessionCatalogLocator = Static<typeof SessionCatalogLocatorSchema>;
export type SessionCatalogDescriptor = Static<typeof SessionCatalogDescriptorSchema>;
export type SessionCatalogPullRequestSummary = Static<
  typeof SessionCatalogPullRequestSummarySchema
>;
export type SessionCatalogSession = Static<typeof SessionCatalogSessionSchema>;
export type SessionCatalogHost = Static<typeof SessionCatalogHostSchema>;
export type SessionCatalog = Static<typeof SessionCatalogSchema>;
export type SessionsCatalogListParams = Static<typeof SessionsCatalogListParamsSchema>;
export type SessionsCatalogListResult = Static<typeof SessionsCatalogListResultSchema>;
export type SessionsCatalogHostEvent = Static<typeof SessionsCatalogHostEventSchema>;
export type SessionCatalogTranscriptItem = Static<typeof SessionCatalogTranscriptItemSchema>;
export type SessionsCatalogReadParams = Static<typeof SessionsCatalogReadParamsSchema>;
export type SessionsCatalogReadResult = Static<typeof SessionsCatalogReadResultSchema>;
export type SessionsCatalogContinueParams = Static<typeof SessionsCatalogContinueParamsSchema>;
export type SessionsCatalogContinueResult = Static<typeof SessionsCatalogContinueResultSchema>;
export type SessionsCatalogArchiveParams = Static<typeof SessionsCatalogArchiveParamsSchema>;
export type SessionsCatalogArchiveResult = Static<typeof SessionsCatalogArchiveResultSchema>;

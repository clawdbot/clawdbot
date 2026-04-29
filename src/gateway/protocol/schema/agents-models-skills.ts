import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    alias: Type.Optional(NonEmptyString),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(
      Type.Object(
        {
          primary: Type.Optional(NonEmptyString),
          fallbacks: Type.Optional(Type.Array(NonEmptyString)),
        },
        { additionalProperties: false },
      ),
    ),
    agentRuntime: Type.Optional(
      Type.Object(
        {
          id: NonEmptyString,
          fallback: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("none")])),
          source: Type.Union([
            Type.Literal("env"),
            Type.Literal("agent"),
            Type.Literal("defaults"),
            Type.Literal("implicit"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const AgentsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object(
  {
    view: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("configured"), Type.Literal("all")]),
    ),
  },
  { additionalProperties: false },
);

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Union([
  Type.Object(
    {
      name: NonEmptyString,
      installId: NonEmptyString,
      dangerouslyForceUnsafeInstall: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      slug: NonEmptyString,
      version: Type.Optional(NonEmptyString),
      force: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
]);

export const SkillsUpdateParamsSchema = Type.Union([
  Type.Object(
    {
      skillKey: NonEmptyString,
      enabled: Type.Optional(Type.Boolean()),
      apiKey: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      slug: Type.Optional(NonEmptyString),
      all: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

export const SkillsSearchParamsSchema = Type.Object(
  {
    query: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const SkillsSearchResultSchema = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          score: Type.Number(),
          slug: NonEmptyString,
          displayName: NonEmptyString,
          summary: Type.Optional(Type.String()),
          version: Type.Optional(NonEmptyString),
          updatedAt: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SkillsDetailParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsDetailResultSchema = Type.Object(
  {
    skill: Type.Union([
      Type.Object(
        {
          slug: NonEmptyString,
          displayName: NonEmptyString,
          summary: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
          createdAt: Type.Integer(),
          updatedAt: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    latestVersion: Type.Optional(
      Type.Union([
        Type.Object(
          {
            version: NonEmptyString,
            createdAt: Type.Integer(),
            changelog: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    metadata: Type.Optional(
      Type.Union([
        Type.Object(
          {
            os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
            systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    owner: Type.Optional(
      Type.Union([
        Type.Object(
          {
            handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            image: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ToolCatalogProfileSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ToolCatalogEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    optional: Type.Optional(Type.Boolean()),
    risk: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    tags: Type.Optional(Type.Array(NonEmptyString)),
    defaultProfiles: Type.Array(
      Type.Union([
        Type.Literal("minimal"),
        Type.Literal("coding"),
        Type.Literal("messaging"),
        Type.Literal("full"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ToolCatalogGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    tools: Type.Array(ToolCatalogEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profiles: Type.Array(ToolCatalogProfileSchema),
    groups: Type.Array(ToolCatalogGroupSchema),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    rawDescription: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin"), Type.Literal("channel")]),
    pluginId: Type.Optional(NonEmptyString),
    channelId: Type.Optional(NonEmptyString),
    risk: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    tags: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveGroupSchema = Type.Object(
  {
    id: Type.Union([Type.Literal("core"), Type.Literal("plugin"), Type.Literal("channel")]),
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin"), Type.Literal("channel")]),
    tools: Type.Array(ToolsEffectiveEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profile: NonEmptyString,
    groups: Type.Array(ToolsEffectiveGroupSchema),
  },
  { additionalProperties: false },
);

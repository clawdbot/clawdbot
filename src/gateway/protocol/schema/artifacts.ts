import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const ArtifactQueryParamsProperties = {
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  taskId: Type.Optional(NonEmptyString),
};

export const ArtifactQueryParamsSchema = Type.Object(ArtifactQueryParamsProperties, {
  additionalProperties: false,
});

export const ArtifactGetParamsSchema = Type.Object(
  {
    ...ArtifactQueryParamsProperties,
    artifactId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ArtifactSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    type: NonEmptyString,
    title: NonEmptyString,
    mimeType: Type.Optional(NonEmptyString),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionKey: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    taskId: Type.Optional(NonEmptyString),
    messageSeq: Type.Optional(Type.Integer({ minimum: 1 })),
    source: Type.Optional(NonEmptyString),
    download: Type.Object(
      {
        mode: Type.Union([Type.Literal("bytes"), Type.Literal("url"), Type.Literal("unsupported")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ArtifactsListParamsSchema = ArtifactQueryParamsSchema;

export const ArtifactsListResultSchema = Type.Object(
  {
    artifacts: Type.Array(ArtifactSummarySchema),
  },
  { additionalProperties: false },
);

export const ArtifactsGetParamsSchema = ArtifactGetParamsSchema;

export const ArtifactsGetResultSchema = Type.Object(
  {
    artifact: ArtifactSummarySchema,
  },
  { additionalProperties: false },
);

export const ArtifactsDownloadParamsSchema = ArtifactGetParamsSchema;

export const ArtifactsDownloadResultSchema = Type.Object(
  {
    artifact: ArtifactSummarySchema,
    encoding: Type.Optional(Type.Literal("base64")),
    data: Type.Optional(Type.String()),
    url: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

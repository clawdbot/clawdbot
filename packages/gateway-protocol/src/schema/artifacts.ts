// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Artifact lookup and download protocol schemas.
 *
 * Artifacts are files or payloads produced by sessions, runs, tasks, or agents;
 * these schemas keep lookup filters explicit and download results transport-safe.
 */
const ArtifactQueryParamsProperties = {
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  taskId: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
};

/** Shared artifact filter payload used by list-style requests. */
export const ArtifactQueryParamsSchema = Type.Object(ArtifactQueryParamsProperties, {
  additionalProperties: false,
});

/** Artifact lookup payload with a required artifact id plus optional scope filters. */
export const ArtifactGetParamsSchema = Type.Object(
  {
    ...ArtifactQueryParamsProperties,
    artifactId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Public artifact metadata returned before or alongside download data. */
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

/** List request payload for artifacts visible in the selected scope. */
export const ArtifactsListParamsSchema = ArtifactQueryParamsSchema;

/** List response containing artifact summaries only. */
export const ArtifactsListResultSchema = Type.Object(
  {
    artifacts: Type.Array(ArtifactSummarySchema),
  },
  { additionalProperties: false },
);

/** Get request payload for one artifact summary. */
export const ArtifactsGetParamsSchema = ArtifactGetParamsSchema;

/** Get response containing one artifact summary. */
export const ArtifactsGetResultSchema = Type.Object(
  {
    artifact: ArtifactSummarySchema,
  },
  { additionalProperties: false },
);

/** Download request payload for one artifact. */
export const ArtifactsDownloadParamsSchema = ArtifactGetParamsSchema;

/** Download response, either inline base64 bytes, URL, or metadata for unsupported modes. */
export const ArtifactsDownloadResultSchema = Type.Object(
  {
    artifact: ArtifactSummarySchema,
    encoding: Type.Optional(Type.Literal("base64")),
    data: Type.Optional(Type.String()),
    url: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

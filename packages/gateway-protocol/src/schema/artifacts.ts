// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
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
const ArtifactQueryParamsSchema = closedObject(ArtifactQueryParamsProperties);

/** Artifact lookup payload with a required artifact id plus optional scope filters. */
const ArtifactGetParamsSchema = closedObject({
  ...ArtifactQueryParamsProperties,
  artifactId: NonEmptyString,
});

/** Public artifact metadata returned before or alongside download data. */
export const ArtifactSummarySchema = closedObject({
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
  download: closedObject({
    mode: Type.Union([Type.Literal("bytes"), Type.Literal("url"), Type.Literal("unsupported")]),
  }),
});

/** List request payload for artifacts visible in the selected scope. */
export const ArtifactsListParamsSchema = ArtifactQueryParamsSchema;

/** List response containing artifact summaries only. */
export const ArtifactsListResultSchema = closedObject({
  artifacts: Type.Array(ArtifactSummarySchema),
});

/** Get request payload for one artifact summary. */
export const ArtifactsGetParamsSchema = ArtifactGetParamsSchema;

/** Get response containing one artifact summary. */
export const ArtifactsGetResultSchema = closedObject({
  artifact: ArtifactSummarySchema,
});

/** Download request payload for one artifact. */
export const ArtifactsDownloadParamsSchema = ArtifactGetParamsSchema;

/** Download response, either inline base64 bytes, URL, or metadata for unsupported modes. */
export const ArtifactsDownloadResultSchema = closedObject({
  artifact: ArtifactSummarySchema,
  encoding: Type.Optional(Type.Literal("base64")),
  data: Type.Optional(Type.String()),
  url: Type.Optional(NonEmptyString),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type ArtifactSummary = Static<typeof ArtifactSummarySchema>;
export type ArtifactsListParams = Static<typeof ArtifactsListParamsSchema>;
export type ArtifactsListResult = Static<typeof ArtifactsListResultSchema>;
export type ArtifactsGetParams = Static<typeof ArtifactsGetParamsSchema>;
export type ArtifactsGetResult = Static<typeof ArtifactsGetResultSchema>;
export type ArtifactsDownloadParams = Static<typeof ArtifactsDownloadParamsSchema>;
export type ArtifactsDownloadResult = Static<typeof ArtifactsDownloadResultSchema>;

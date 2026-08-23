import { Type } from "typebox";
import type { ImageContent, TextContent } from "../../../llm/types.js";
import { ReadToolContinuationSchema, type ReadToolDetails } from "./tool-contracts.js";

export const readToolInputSchema = Type.Object({
  path: Type.String({ description: "File path; relative/absolute." }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Start line; 1-based." })),
  limit: Type.Optional(Type.Number({ description: "Max lines." })),
  cursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "Character position within the start line; 0-based." }),
  ),
  optional: Type.Optional(
    Type.Literal(true, {
      description: "Missing paths return structured not_found instead of failing.",
    }),
  ),
});

const readTruncationOutputSchema = Type.Object(
  {
    truncated: Type.Literal(true),
    truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes")]),
    totalLines: Type.Integer({ minimum: 0 }),
    totalBytes: Type.Integer({ minimum: 0 }),
    outputLines: Type.Integer({ minimum: 0 }),
    outputBytes: Type.Integer({ minimum: 0 }),
    lastLinePartial: Type.Boolean(),
    firstLineExceedsLimit: Type.Boolean(),
    maxLines: Type.Integer({ minimum: 1 }),
    maxBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const readToolOutputSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("text"), content: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("image"),
      content: Type.String(),
      mimeType: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("truncated"),
      content: Type.String(),
      truncation: readTruncationOutputSchema,
      continuation: ReadToolContinuationSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("not_found"),
      status: Type.Literal("not_found"),
      path: Type.String(),
      optional: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
]);

export function createReadToolDetails(
  content: (TextContent | ImageContent)[],
  truncated?: Extract<ReadToolDetails, { kind: "truncated" }>,
): ReadToolDetails {
  const text = content.find((part): part is TextContent => part.type === "text")?.text ?? "";
  const image = content.find((part): part is ImageContent => part.type === "image");
  if (image) {
    return { kind: "image", content: text, mimeType: image.mimeType };
  }
  if (truncated) {
    return { ...truncated, content: text };
  }
  return { kind: "text", content: text };
}

// Gateway Protocol schema module defines memory browser validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** One persisted daily memory file under an agent workspace. */
export const MemoryListFileSchema = closedObject({
  name: NonEmptyString,
  path: NonEmptyString,
  date: NonEmptyString,
  slug: Type.Optional(Type.String()),
  truncated: Type.Boolean(),
  content: Type.Optional(Type.String()),
});

/** Optional canonical root memory file payload. */
export const MemoryListRootMemorySchema = closedObject({
  name: NonEmptyString,
  path: NonEmptyString,
  truncated: Type.Boolean(),
  content: Type.Optional(Type.String()),
});

/** Lists persisted memory files for one agent workspace. */
export const MemoryListParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  includeContent: Type.Optional(Type.Boolean()),
  includeRootMemory: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 0 })),
  maxContentBytes: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Result for read-only persisted memory enumeration. */
export const MemoryListResultSchema = closedObject({
  agentId: NonEmptyString,
  memoryDir: NonEmptyString,
  totalFiles: Type.Integer({ minimum: 0 }),
  returnedFiles: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  files: Type.Array(MemoryListFileSchema),
  rootMemory: Type.Optional(Type.Union([MemoryListRootMemorySchema, Type.Null()])),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type MemoryListFile = Static<typeof MemoryListFileSchema>;
export type MemoryListRootMemory = Static<typeof MemoryListRootMemorySchema>;
export type MemoryListParams = Static<typeof MemoryListParamsSchema>;
export type MemoryListResult = Static<typeof MemoryListResultSchema>;

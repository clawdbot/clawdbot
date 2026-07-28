// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Read-only persisted memory enumeration schemas.
 *
 * These contracts back the `memory.list` gateway method that lets
 * operator-read clients enumerate what the agent has persisted in the
 * default agent workspace memory area (`memory/<YYYY-MM-DD>.md` daily
 * files plus the optional root `MEMORY.md`). The surface is deliberately
 * read-only: writes, deletes, and memory management stay out of this
 * namespace.
 */

/** Maximum number of memory files returned by one memory.list call. */
export const MEMORY_LIST_MAX_FILES = 366;
/** Maximum per-file content bytes returned by one memory.list call. */
export const MEMORY_LIST_MAX_CONTENT_BYTES = 256 * 1024;

/** One persisted memory file entry (daily file or root MEMORY.md). */
export const MemoryFileEntrySchema = closedObject({
  path: NonEmptyString,
  name: NonEmptyString,
  sizeBytes: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  content: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
});

/** Enumerates persisted memory files in the default agent workspace. */
export const MemoryListParamsSchema = closedObject({
  // Bounds are clamped handler-side (defaults 90 files / 64 KiB, maxima
  // MEMORY_LIST_MAX_FILES / MEMORY_LIST_MAX_CONTENT_BYTES) so out-of-range
  // requests degrade to the cap instead of failing validation.
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  includeContent: Type.Optional(Type.Boolean()),
  includeRootMemory: Type.Optional(Type.Boolean()),
  maxContentBytes: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** Result for one persisted memory enumeration. */
export const MemoryListResultSchema = closedObject({
  agentId: NonEmptyString,
  files: Type.Array(MemoryFileEntrySchema),
  totalFiles: Type.Integer({ minimum: 0 }),
  returnedFiles: Type.Integer({ minimum: 0 }),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type MemoryFileEntry = Static<typeof MemoryFileEntrySchema>;
export type MemoryListParams = Static<typeof MemoryListParamsSchema>;
export type MemoryListResult = Static<typeof MemoryListResultSchema>;

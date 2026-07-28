import * as memory from "./memory.js";

export const MemoryProtocolSchemas = {
  MemoryListParams: memory.MemoryListParamsSchema,
  MemoryListResult: memory.MemoryListResultSchema,
  MemoryFileEntry: memory.MemoryFileEntrySchema,
} as const;

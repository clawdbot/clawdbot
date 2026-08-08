/**
 * Public SDK subpath for memory host runtime file path helpers.
 */
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export {
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  readAgentMemoryFile,
  resolveMemoryBackendConfig,
} from "../../packages/memory-host-sdk/src/runtime-files.js";
export type {
  MemoryEntryProvenance,
  MemoryOriginClass,
  MemorySearchResult,
  MemorySearchRuntimeDebug,
  MemorySessionKind,
} from "../../packages/memory-host-sdk/src/runtime-files.js";

const loadMemoryFileStore = createLazyRuntimeModule(() => import("../agents/memory-file-store.js"));

export async function appendMemoryFileEntry(
  params: import("../agents/memory-file-store.js").MemoryFileAppendParams,
): Promise<import("../agents/memory-file-store.js").MemoryFileAppendResult> {
  return await (await loadMemoryFileStore()).appendMemoryFileEntry(params);
}

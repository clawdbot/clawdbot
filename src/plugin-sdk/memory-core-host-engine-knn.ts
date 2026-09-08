// Per-query children need SQLite and text primitives, not the memory manager,
// schema migrations, or agent configuration exported by the broader host barrels.
export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
export { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
export { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
export {
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";

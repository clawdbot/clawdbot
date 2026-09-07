// Narrow sqlite-vec extension loader for the memory-search-knn child and other
// performance-critical subprocesses. Importing this barrel avoids pulling in the
// heavy memory-schema exports from the sibling engine-schema barrel. (#140681)
export { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";

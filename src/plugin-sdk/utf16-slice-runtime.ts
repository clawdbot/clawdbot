// Narrow UTF-16 safe truncation helper for performance-critical subprocesses
// (e.g. the memory-search-knn child) that must not pull in the full foundation
// barrel's dependency tree. (#140681)
export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

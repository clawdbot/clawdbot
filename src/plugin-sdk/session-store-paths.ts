// Session store path resolution.
//
// Split from the `session-store-runtime` barrel, which also value-loads the
// session accessor/state-database graph. Doctor legacy-state closures only need
// to locate a store file, and doctor enumeration cold-loads those closures.

export { resolveStorePath } from "../config/sessions/paths.js";

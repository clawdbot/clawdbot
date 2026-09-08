// Keep the gateway's dynamic boundary separate from the CLI runtime, which
// also owns a static session-backfill import for command execution.
export { executeSessionBackfill, executeSessionBackfillBatch } from "./session-backfill.js";

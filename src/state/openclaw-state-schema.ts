import { fileURLToPath } from "node:url";

// Use the native builtin so unrelated node:fs mocks cannot replace this source input.
// Production builds and Vitest replace this module with the current canonical SQL bytes so
// packaged database opens (including lazy replay-ledger tables) need no asset file.
export const OPENCLAW_STATE_SCHEMA_SQL = process
  .getBuiltinModule("node:fs")
  .readFileSync(fileURLToPath(new URL("./openclaw-state-schema.sql", import.meta.url)), "utf8");

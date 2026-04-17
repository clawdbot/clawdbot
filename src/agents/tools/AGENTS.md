# Agent Tools Performance

Tool tests should not load full channel or plugin runtimes for static tool
descriptions.

## Guardrails

- Message-tool discovery should flow through shared discovery helpers and
  lightweight channel artifacts before falling back to a full channel plugin
  load.
- Channel-specific tool schemas, action lists, and static capabilities belong
  in plugin-owned helpers that are reused by both the full plugin and the
  lightweight artifact.
- Do not add direct bundled-plugin imports to agent tool tests for schema or
  capability assertions. If the production path needs the same data, promote a
  small public artifact instead.
- If a single assertion starts paying multi-second import/setup cost, split the
  static descriptor path from runtime execution instead of adding more mocks
  around the broad import.

## Verification

- For `src/agents/tools/*.test.ts` performance work, compare targeted file
  runtime with `pnpm test <file>` before/after.
- Run `pnpm build` when adding or changing bundled plugin artifacts.

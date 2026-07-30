/**
 * Per-spawn runtime tool policy type for `sessions_spawn`.
 *
 * Lives in the config layer so `SessionEntry` can reference it without a
 * reverse dependency on the agent runtime. Normalization and conversion
 * logic lives in `src/agents/runtime-tool-policy.ts`.
 *
 * Semantics:
 * - `undefined` — no restriction (inherit the default tool set).
 * - `"none"` — the child session exposes zero callable tools to the model,
 *   including forced/message/heartbeat/tool-search/bundle/ring-zero tools.
 * - `{ allow?, deny? }` — deny-wins narrowing of the tool set. An explicit
 *   empty `allow` array is normalized to `"none"` (not "allow everything").
 */
export type RuntimeToolPolicy =
  | "none"
  | {
      allow?: string[];
      deny?: string[];
    };

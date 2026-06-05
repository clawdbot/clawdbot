// Gateway shared request-state types.
// Defines cached dedupe entries for idempotent Gateway method calls.
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";

// Dedupe entries cache recent request results so repeated gateway calls can
// replay the same success/error payload without re-running the method.
export type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

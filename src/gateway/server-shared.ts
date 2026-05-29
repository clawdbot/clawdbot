import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";

export type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

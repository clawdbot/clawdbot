import type { ErrorShape } from "../../../packages/gateway-protocol/src/schema/frames.js";

/** Callback used by method handlers to emit one protocol response frame. */
export type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: ErrorShape,
  meta?: Record<string, unknown>,
) => void;

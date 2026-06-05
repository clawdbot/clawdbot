// Stream payload utilities normalize provider stream payload fields for wrappers.
import type { StreamFn } from "../../../agents/runtime/index.js";

/** Wraps a stream function and lets callers mutate outgoing provider payload objects. */
export function streamWithPayloadPatch(
  underlying: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  patchPayload: (payload: Record<string, unknown>) => void,
): ReturnType<StreamFn> {
  const originalOnPayload = options?.onPayload;
  return underlying(model, context, {
    ...options,
    onPayload: (payload) => {
      // Payload hooks receive mutable provider request objects before the underlying sender uses them.
      if (payload && typeof payload === "object") {
        patchPayload(payload as Record<string, unknown>);
      }
      return originalOnPayload?.(payload, model);
    },
  });
}

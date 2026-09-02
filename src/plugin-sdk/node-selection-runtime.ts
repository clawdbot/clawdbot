// Shared node-selection policy for bundled plugin runtime code.
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadNodeExecRuntime = createLazyRuntimeModule(
  () => import("../agents/node-exec-availability.js"),
);

export type { EligibleNodeMessages } from "../shared/node-resolve.js";
export { resolveEligibleNodeFromList } from "../shared/node-resolve.js";

/** Loads current exec eligibility only when a harness is building its tool catalog. */
export async function loadNodeExecAvailability(signal?: AbortSignal) {
  const runtime = await loadNodeExecRuntime();
  return runtime.loadNodeExecAvailability(signal);
}

// Shared runtime helpers for agent management commands.
import type { RuntimeEnv } from "../runtime.js";

/** Wrap a runtime so helper setup work stays silent in JSON output paths. */
export function createQuietRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return { ...runtime, log: () => {} };
}

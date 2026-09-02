import { runPreparedEmbeddedLoop } from "./run-loop.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/** Runs one fully prepared embedded-agent request. */
export function executePreparedEmbeddedRun(
  input: PreparedEmbeddedRunInput,
): Promise<EmbeddedAgentRunResult> {
  return runPreparedEmbeddedLoop(input);
}

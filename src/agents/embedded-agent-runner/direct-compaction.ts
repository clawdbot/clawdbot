/** Coordinates one direct compaction attempt through explicit lifecycle phases. */
import { formatErrorMessage } from "../../infra/errors.js";
import { executePreparedCompactionSession } from "./compaction-session-execution.js";
import {
  prepareDirectCompactionAttempt,
  type PreparedCompactEmbeddedAgentSessionParams,
} from "./direct-compaction-preparation.js";
import {
  buildPreparedCompactionRuntime,
  type PreparedCompactionRuntime,
} from "./prepared-compaction-runtime.js";

export async function compactEmbeddedAgentSessionDirectOnce(
  params: PreparedCompactEmbeddedAgentSessionParams,
) {
  const preparation = await prepareDirectCompactionAttempt(params);
  if (!preparation.ok) {
    return preparation.result;
  }

  let runtime: PreparedCompactionRuntime | undefined;
  try {
    runtime = await buildPreparedCompactionRuntime(preparation.value);
    return await executePreparedCompactionSession(runtime);
  } catch (err) {
    return preparation.value.fail(formatErrorMessage(err), err);
  } finally {
    await runtime?.dispose();
  }
}

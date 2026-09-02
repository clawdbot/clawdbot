import { note } from "../../packages/terminal-core/src/note.js";
import { formatErrorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";

type DoctorAgentDatabaseOperationResult<T> = { ok: true; value: T } | { ok: false };

/** Keep one unusable agent database from aborting sibling Doctor work. */
export function runDoctorAgentDatabaseOperation<T>(params: {
  agentId: string;
  path: string;
  run: () => T;
}): DoctorAgentDatabaseOperationResult<T> {
  try {
    return { ok: true, value: params.run() };
  } catch (error) {
    note(
      `- Agent ${params.agentId} database ${shortenHomePath(params.path)}: ${formatErrorMessage(error)}`,
      "Doctor warnings",
    );
    return { ok: false };
  }
}

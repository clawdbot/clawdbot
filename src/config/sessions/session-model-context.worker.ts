import { serveWorkerTasks } from "../../infra/worker-task-pool.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

export type SessionModelContextWorkerInput = {
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

serveWorkerTasks((input) => {
  // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
  const request = input as SessionModelContextWorkerInput;
  return runWithSessionTranscriptReadFence(request.admission, () =>
    readSessionTranscriptModelContext(request.target),
  );
});

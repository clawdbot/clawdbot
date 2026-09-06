import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionModelContextWorkerInput } from "./session-model-context.worker.js";

const modelContextReads = new WorkerTaskPool<
  SessionModelContextWorkerInput,
  ReturnType<typeof readSessionTranscriptModelContext>
>({
  workerUrl: resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "session-model-context.worker",
    distWorkerPath: "config/sessions/session-model-context.worker.js",
  }),
  // Preserve context-read admission order and avoid multiplying large SQLite scans.
  maxWorkers: 1,
});

export async function readSessionTranscriptModelContextAsync(
  target: SessionTranscriptRuntimeTarget,
  admission: SessionModelContextWorkerInput["admission"],
  signal?: AbortSignal,
  through?: SessionModelContextWorkerInput["through"],
): Promise<ReturnType<typeof readSessionTranscriptModelContext>> {
  signal?.throwIfAborted();
  // Incognito SQLite is process memory; another isolate cannot read that database.
  if (isIncognitoSessionKey(target.sessionKey)) {
    return readSessionTranscriptModelContext(target, through);
  }
  return modelContextReads.run({ target, admission, through }, { timeoutMs: 60_000, signal });
}

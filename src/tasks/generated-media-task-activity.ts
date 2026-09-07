import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const GENERATED_MEDIA_TASK_ACTIVITY_KEY = Symbol.for("openclaw.generatedMediaTaskActivity");
const GENERATED_MEDIA_TASK_ADMISSIONS_KEY = Symbol.for("openclaw.generatedMediaTaskAdmissions");
const GENERATED_MEDIA_TASK_ADMISSIONS_MAX_ENTRIES = 2_048;

function getActiveGeneratedMediaTasks(): Map<string, string> {
  return resolveGlobalSingleton(GENERATED_MEDIA_TASK_ACTIVITY_KEY, () => new Map<string, string>());
}

function getLatestGeneratedMediaTaskAdmissions(): Map<string, string> {
  return resolveGlobalSingleton(
    GENERATED_MEDIA_TASK_ADMISSIONS_KEY,
    () => new Map<string, string>(),
  );
}

/** Tracks in-process generated-media work even when a plugin owns task persistence. */
export function registerGeneratedMediaTaskActivity(runId: string, sessionKey: string): void {
  if (!runId || !sessionKey) {
    return;
  }
  const active = getActiveGeneratedMediaTasks();
  if (!active.has(runId)) {
    const admissions = getLatestGeneratedMediaTaskAdmissions();
    admissions.delete(sessionKey);
    admissions.set(sessionKey, runId);
    pruneMapToMaxSize(admissions, GENERATED_MEDIA_TASK_ADMISSIONS_MAX_ENTRIES);
  }
  active.set(runId, sessionKey);
}

/** Clears in-process generated-media activity after terminal task bookkeeping. */
export function clearGeneratedMediaTaskActivity(runId: string): void {
  getActiveGeneratedMediaTasks().delete(runId);
}

/** Lists active generated-media run ids for one exact requester session. */
export function listActiveGeneratedMediaTaskIdsForSessionKey(sessionKey: string): string[] {
  const runIds: string[] = [];
  for (const [runId, requesterSessionKey] of getActiveGeneratedMediaTasks()) {
    if (requesterSessionKey === sessionKey) {
      runIds.push(runId);
    }
  }
  return runIds;
}

/** Returns the set of all session keys with in-process generated-media activity. */
export function getAllActiveGeneratedMediaSessionKeys(): Set<string> {
  return new Set(getActiveGeneratedMediaTasks().values());
}

/** Returns the latest admitted run id even after that task became terminal. */
export function getLatestGeneratedMediaTaskAdmissionIdForSessionKey(
  sessionKey: string,
): string | undefined {
  return getLatestGeneratedMediaTaskAdmissions().get(sessionKey);
}

function resetGeneratedMediaTaskActivityForTests(): void {
  getActiveGeneratedMediaTasks().clear();
  getLatestGeneratedMediaTaskAdmissions().clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.generatedMediaTaskActivityTestApi")
  ] = { resetGeneratedMediaTaskActivityForTests };
}

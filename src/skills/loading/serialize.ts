// Skill serialization helpers compact skill metadata and coordinate sync queue updates.
const SKILLS_SYNC_QUEUE = new Map<string, Promise<unknown>>();

/** Serializes async work by key so repeated skill loads do not race on shared files. */
export async function serializeByKey<T>(key: string, task: () => Promise<T>) {
  const prev = SKILLS_SYNC_QUEUE.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  SKILLS_SYNC_QUEUE.set(key, next);
  try {
    return await next;
  } finally {
    if (SKILLS_SYNC_QUEUE.get(key) === next) {
      SKILLS_SYNC_QUEUE.delete(key);
    }
  }
}

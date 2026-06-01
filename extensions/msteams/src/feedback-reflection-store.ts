import crypto from "node:crypto";
import { getMSTeamsRuntime } from "./runtime.js";

/** Default cooldown between reflections per session (5 minutes). */
export const DEFAULT_COOLDOWN_MS = 300_000;

/** Tracks last reflection time per session to enforce cooldown. */
const lastReflectionBySession = new Map<string, number>();

/** Maximum cooldown entries before pruning expired ones. */
const MAX_COOLDOWN_ENTRIES = 500;
const LEARNINGS_NAMESPACE = "feedback-learnings";
const MAX_LEARNING_ENTRIES = 10_000;

type FeedbackLearningEntry = {
  sessionKey: string;
  learnings: string[];
  updatedAt: number;
};

function learningStoreKey(storePath: string, sessionKey: string): string {
  return crypto.createHash("sha256").update(`${storePath}\0${sessionKey}`, "utf8").digest("hex");
}

function openLearningStore() {
  return getMSTeamsRuntime().state.openKeyedStore<FeedbackLearningEntry>({
    namespace: LEARNINGS_NAMESPACE,
    maxEntries: MAX_LEARNING_ENTRIES,
  });
}

/** Prune expired cooldown entries to prevent unbounded memory growth. */
function pruneExpiredCooldowns(cooldownMs: number): void {
  if (lastReflectionBySession.size <= MAX_COOLDOWN_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, time] of lastReflectionBySession) {
    if (now - time >= cooldownMs) {
      lastReflectionBySession.delete(key);
    }
  }
}

/** Check if a reflection is allowed (cooldown not active). */
export function isReflectionAllowed(sessionKey: string, cooldownMs?: number): boolean {
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastTime = lastReflectionBySession.get(sessionKey);
  if (lastTime == null) {
    return true;
  }
  return Date.now() - lastTime >= cooldown;
}

/** Record that a reflection was run for a session. */
export function recordReflectionTime(sessionKey: string, cooldownMs?: number): void {
  lastReflectionBySession.set(sessionKey, Date.now());
  pruneExpiredCooldowns(cooldownMs ?? DEFAULT_COOLDOWN_MS);
}

/** Clear reflection cooldown tracking (for tests). */
export function clearReflectionCooldowns(): void {
  lastReflectionBySession.clear();
}

/** Store a learning derived from feedback reflection. */
export async function storeSessionLearning(params: {
  storePath: string;
  sessionKey: string;
  learning: string;
}): Promise<void> {
  const store = openLearningStore();
  const key = learningStoreKey(params.storePath, params.sessionKey);
  const existing = await store.lookup(key);
  let learnings = existing?.learnings ?? [];
  learnings.push(params.learning);
  if (learnings.length > 10) {
    learnings = learnings.slice(-10);
  }
  await store.register(key, {
    sessionKey: params.sessionKey,
    learnings,
    updatedAt: Date.now(),
  });
}

/** Load session learnings for injection into extraSystemPrompt. */
export async function loadSessionLearnings(
  storePath: string,
  sessionKey: string,
): Promise<string[]> {
  const key = learningStoreKey(storePath, sessionKey);
  const stored = await openLearningStore().lookup(key);
  if (stored) {
    return stored.learnings;
  }
  return [];
}

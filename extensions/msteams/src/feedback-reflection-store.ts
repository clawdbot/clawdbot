import crypto from "node:crypto";
import { getMSTeamsRuntime } from "./runtime.js";

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

export async function storeSessionLearning(params: {
  storePath: string;
  sessionKey: string;
  learning: string;
}): Promise<void> {
  const store = getMSTeamsRuntime().state.openKeyedStore<FeedbackLearningEntry>({
    namespace: LEARNINGS_NAMESPACE,
    maxEntries: MAX_LEARNING_ENTRIES,
  });
  const key = learningStoreKey(params.storePath, params.sessionKey);
  if (!store.update) {
    throw new Error("plugin state atomic update is unavailable");
  }
  await store.update(key, (existing) => ({
    sessionKey: params.sessionKey,
    learnings: [...(existing?.learnings ?? []), params.learning].slice(-10),
    updatedAt: Date.now(),
  }));
}

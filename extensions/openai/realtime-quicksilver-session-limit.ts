// Shared process-wide cap for browser and Gateway-relay GPT-Live sessions.
const OPENAI_QUICKSILVER_MAX_SESSIONS = 8;
const reservations = new Set<unknown>();

export function reserveOpenAIQuicksilverSession(owner: unknown): void {
  if (reservations.has(owner)) {
    return;
  }
  if (reservations.size >= OPENAI_QUICKSILVER_MAX_SESSIONS) {
    throw new Error("Too many concurrent OpenAI GPT-Live sessions; try again in a minute");
  }
  reservations.add(owner);
}

export function releaseOpenAIQuicksilverSession(owner: unknown): void {
  reservations.delete(owner);
}

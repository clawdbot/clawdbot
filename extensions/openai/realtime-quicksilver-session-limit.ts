// Shared process-wide cap for browser and Gateway-relay GPT-Live sessions.
const OPENAI_QUICKSILVER_MAX_SESSIONS = 8;
const reservations = new Map<unknown, number | undefined>();

export function reserveOpenAIQuicksilverSession(
  owner: unknown,
  opts?: { expiresAtMs?: number },
): void {
  const now = Date.now();
  for (const [reservedOwner, expiresAtMs] of reservations) {
    if (expiresAtMs !== undefined && expiresAtMs <= now) {
      reservations.delete(reservedOwner);
    }
  }
  if (reservations.has(owner)) {
    reservations.set(owner, opts?.expiresAtMs);
    return;
  }
  if (reservations.size >= OPENAI_QUICKSILVER_MAX_SESSIONS) {
    throw new Error("Too many concurrent OpenAI GPT-Live sessions; try again in a minute");
  }
  reservations.set(owner, opts?.expiresAtMs);
}

export function releaseOpenAIQuicksilverSession(owner: unknown): void {
  reservations.delete(owner);
}

// Shared process-wide cap for browser and Gateway-relay GPT-Live sessions.
const OPENAI_QUICKSILVER_MAX_SESSIONS = 8;
const REALTIME_MAX_SESSIONS_PER_OWNER = 2;
const reservations = new Map<unknown, { expiresAtMs?: number; ownerConnId?: string }>();

export function reserveOpenAIQuicksilverSession(
  owner: unknown,
  opts?: { expiresAtMs?: number; ownerConnId?: string },
): void {
  const now = Date.now();
  for (const [reservedOwner, { expiresAtMs }] of reservations) {
    if (expiresAtMs !== undefined && expiresAtMs <= now) {
      reservations.delete(reservedOwner);
    }
  }
  const existing = reservations.get(owner);
  if (existing) {
    existing.expiresAtMs = opts?.expiresAtMs;
    return;
  }
  if (
    opts?.ownerConnId &&
    Array.from(reservations.values()).filter((entry) => entry.ownerConnId === opts.ownerConnId)
      .length >= REALTIME_MAX_SESSIONS_PER_OWNER
  ) {
    throw new Error("Too many concurrent OpenAI realtime sessions for this client");
  }
  if (reservations.size >= OPENAI_QUICKSILVER_MAX_SESSIONS) {
    throw new Error("Too many concurrent OpenAI GPT-Live sessions; try again in a minute");
  }
  reservations.set(owner, { ...opts });
}

export function releaseOpenAIQuicksilverSession(owner: unknown): void {
  reservations.delete(owner);
}

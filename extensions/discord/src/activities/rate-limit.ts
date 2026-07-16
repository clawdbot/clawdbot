const TOKEN_RATE_LIMIT = 10;
const TOKEN_GLOBAL_RATE_LIMIT = 60;
const TOKEN_RATE_WINDOW_MS = 60_000;
const TOKEN_RATE_MAX_KEYS = 1_024;

export class TokenRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private globalAttempts: Array<{ at: number }> = [];

  constructor(private readonly now: () => number) {}

  allowKey(key: string): boolean {
    const now = this.now();
    const active = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > now - TOKEN_RATE_WINDOW_MS,
    );
    if (active.length >= TOKEN_RATE_LIMIT) {
      this.attempts.delete(key);
      this.attempts.set(key, active);
      return false;
    }
    if (!this.attempts.has(key) && this.attempts.size >= TOKEN_RATE_MAX_KEYS) {
      const oldestKey = this.attempts.keys().next().value;
      if (typeof oldestKey === "string") {
        this.attempts.delete(oldestKey);
      }
    }
    active.push(now);
    this.attempts.delete(key);
    this.attempts.set(key, active);
    return true;
  }

  reserveGlobal(): { at: number } | null {
    const now = this.now();
    this.globalAttempts = this.globalAttempts.filter(
      (reservation) => reservation.at > now - TOKEN_RATE_WINDOW_MS,
    );
    if (this.globalAttempts.length >= TOKEN_GLOBAL_RATE_LIMIT) {
      return null;
    }
    const reservation = { at: now };
    this.globalAttempts.push(reservation);
    return reservation;
  }

  releaseGlobal(reservation: { at: number }): void {
    const index = this.globalAttempts.indexOf(reservation);
    if (index >= 0) {
      this.globalAttempts.splice(index, 1);
    }
  }
}

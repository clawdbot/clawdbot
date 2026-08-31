// Freezes and restores time in tests that assert timestamped behavior.
import { vi } from "vitest";

/** Freezes Vitest's fake clock for tests that assert timestamps or timers. */
export function useFrozenTime(at: string | number | Date): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

export function useRealTime(): void {
  vi.useRealTimers();
}

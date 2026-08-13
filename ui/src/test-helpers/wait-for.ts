import { vi } from "vitest";

type WaitForOptions = Exclude<Parameters<typeof vi.waitFor>[1], number | undefined>;

export function waitForFast<T>(assertion: () => T | Promise<T>, options: WaitForOptions = {}) {
  return vi.waitFor(assertion, { interval: 1, ...options });
}

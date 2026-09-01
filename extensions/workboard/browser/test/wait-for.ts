import { vi } from "vitest";

export function waitForFast<T>(assertion: () => T | Promise<T>) {
  return vi.waitFor(assertion, { interval: 1 });
}

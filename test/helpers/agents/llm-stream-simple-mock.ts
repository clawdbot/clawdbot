import { vi } from "vitest";

type LlmMockModule = Record<string, unknown>;

export function createLlmStreamSimpleMock(): LlmMockModule {
  return {
    streamSimple: vi.fn(() => ({
      push: vi.fn(),
      result: vi.fn(async () => undefined),
      [Symbol.asyncIterator]: vi.fn(async function* () {
        // Minimal async stream shape for wrappers that patch iteration/result.
      }),
    })),
  };
}

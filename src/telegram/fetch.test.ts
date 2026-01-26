import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTelegramFetch } from "./fetch.js";

describe("resolveTelegramFetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("returns wrapped global fetch when available", () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const resolved = resolveTelegramFetch();
    expect(resolved).toBeTypeOf("function");
  });

  it("prefers proxy fetch when provided", () => {
    const fetchMock = vi.fn(async () => ({}));
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveTelegramFetch", () => {
  const originalFetch = globalThis.fetch;

  const loadModule = async () => {
    const setDefaultAutoSelectFamily = vi.fn();
    vi.resetModules();
    vi.doMock("node:net", () => ({
      setDefaultAutoSelectFamily,
    }));
    const mod = await import("./fetch.js");
    return { resolveTelegramFetch: mod.resolveTelegramFetch, setDefaultAutoSelectFamily };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("returns wrapped global fetch when available", async () => {
    const fetchMock = vi.fn(async () => ({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch();
    expect(resolved).toBeTypeOf("function");
  });

  it("prefers proxy fetch when provided", async () => {
    const fetchMock = vi.fn(async () => ({}));
    const { resolveTelegramFetch } = await loadModule();
    const resolved = resolveTelegramFetch(fetchMock as unknown as typeof fetch);
    expect(resolved).toBeTypeOf("function");
  });

  it("honors env enable override", async () => {
    vi.stubEnv("CLAWDBOT_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, setDefaultAutoSelectFamily } = await loadModule();
    resolveTelegramFetch();
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("uses config override when provided", async () => {
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, setDefaultAutoSelectFamily } = await loadModule();
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(true);
  });

  it("env disable override wins over config", async () => {
    vi.stubEnv("CLAWDBOT_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY", "1");
    globalThis.fetch = vi.fn(async () => ({})) as unknown as typeof fetch;
    const { resolveTelegramFetch, setDefaultAutoSelectFamily } = await loadModule();
    resolveTelegramFetch(undefined, { network: { autoSelectFamily: true } });
    expect(setDefaultAutoSelectFamily).toHaveBeenCalledWith(false);
  });
});

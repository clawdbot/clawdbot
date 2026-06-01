import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS,
  loadModelCatalogForBrowse,
  restoreModelCatalogBrowseTestDeps,
  setModelCatalogBrowseTestDeps,
} from "./model-catalog-browse.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const readOnlyCatalog: ModelCatalogEntry[] = [
  { id: "gpt-readonly", name: "GPT Readonly", provider: "openai" },
];
const fullCatalog: ModelCatalogEntry[] = [{ id: "gpt-full", name: "GPT Full", provider: "openai" }];

function config(params: { providerWildcard?: boolean } = {}): OpenClawConfig {
  return {
    agents: params.providerWildcard
      ? {
          defaults: {
            models: {
              "openai/*": {},
            },
          },
        }
      : undefined,
  } as OpenClawConfig;
}

describe("loadModelCatalogForBrowse", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreModelCatalogBrowseTestDeps();
  });

  it("uses the read-only catalog for default browse views", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(loadModelCatalogForBrowse({ cfg: config(), loadCatalog })).resolves.toBe(
      readOnlyCatalog,
    );

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("uses the full catalog for all views", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadModelCatalogForBrowse({ cfg: config(), view: "all", loadCatalog }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it("uses the full catalog when configured visibility has provider wildcards", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadModelCatalogForBrowse({ cfg: config({ providerWildcard: true }), loadCatalog }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it("returns an empty catalog when read-only catalog loading times out", async () => {
    const onTimeout = vi.fn();
    const timeoutHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const clearTimeout = vi.fn();
    setModelCatalogBrowseTestDeps({
      setTimeout: vi.fn((callback: () => void) => {
        queueMicrotask(callback);
        return timeoutHandle;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof globalThis.clearTimeout,
    });
    const loadCatalog = vi.fn(() => new Promise<ModelCatalogEntry[]>(() => {}));

    const resultPromise = loadModelCatalogForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: 5,
      onTimeout,
    });

    await expect(resultPromise).resolves.toEqual([]);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
    expect(timeoutHandle["unref"]).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledExactlyOnceWith(timeoutHandle);
  });

  it("uses the default timeout when timeoutMs is non-finite", async () => {
    const onTimeout = vi.fn();
    const timeoutHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setTimeout = vi.fn(() => timeoutHandle);
    const clearTimeout = vi.fn();
    setModelCatalogBrowseTestDeps({
      setTimeout: setTimeout as unknown as typeof globalThis.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof globalThis.clearTimeout,
    });
    const loadCatalog = vi.fn(async () => readOnlyCatalog);

    const resultPromise = loadModelCatalogForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: Number.NaN,
      onTimeout,
    });

    await expect(resultPromise).resolves.toBe(readOnlyCatalog);
    expect(setTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS,
    );
    expect(clearTimeout).toHaveBeenCalledExactlyOnceWith(timeoutHandle);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("caps oversized browse timeouts before scheduling the fallback timer", async () => {
    const timeoutHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setTimeout = vi.fn(() => timeoutHandle);
    const clearTimeout = vi.fn();
    setModelCatalogBrowseTestDeps({
      setTimeout: setTimeout as unknown as typeof globalThis.setTimeout,
      clearTimeout: clearTimeout as unknown as typeof globalThis.clearTimeout,
    });
    const loadCatalog = vi.fn(async () => readOnlyCatalog);

    const resultPromise = loadModelCatalogForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    await expect(resultPromise).resolves.toBe(readOnlyCatalog);
    expect(setTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(clearTimeout).toHaveBeenCalledExactlyOnceWith(timeoutHandle);
  });
});

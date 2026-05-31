import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { loadModelCatalogForBrowse } from "./model-catalog-browse.js";
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
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(
      () =>
        new Promise<ModelCatalogEntry[]>((_, reject) => {
          setTimeout(() => reject(new Error("late catalog failure")), 10);
        }),
    );

    const resultPromise = loadModelCatalogForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: 5,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toEqual([]);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
    await vi.advanceTimersByTimeAsync(10);
  });

  it("uses the default timeout when timeoutMs is non-finite", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(
      () =>
        new Promise<ModelCatalogEntry[]>((resolve) => {
          setTimeout(() => resolve(readOnlyCatalog), 5);
        }),
    );

    const resultPromise = loadModelCatalogForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: Number.NaN,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(5);

    await expect(resultPromise).resolves.toBe(readOnlyCatalog);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("caps oversized browse timeouts before scheduling the fallback timer", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const loadCatalog = vi.fn(
        () =>
          new Promise<ModelCatalogEntry[]>((resolve) => {
            setTimeout(() => resolve(readOnlyCatalog), 5);
          }),
      );

      const resultPromise = loadModelCatalogForBrowse({
        cfg: config(),
        loadCatalog,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(5);

      await expect(resultPromise).resolves.toBe(readOnlyCatalog);
    } finally {
      timeoutSpy.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

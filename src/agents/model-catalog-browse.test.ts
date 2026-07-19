/**
 * Regression coverage for model catalog browsing.
 * Verifies filtered catalog output and pending load behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  loadPreparedModelCatalogSnapshotForBrowse,
} from "./model-catalog-browse.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

const DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS = 750;
const readOnlyCatalog: ModelCatalogSnapshot = {
  entries: [{ id: "gpt-readonly", name: "GPT Readonly", provider: "openai" }],
  routeVariants: [{ id: "gpt-readonly", name: "GPT Readonly", provider: "openai" }],
};
const fullCatalog: ModelCatalogSnapshot = {
  entries: [{ id: "gpt-full", name: "GPT Full", provider: "openai" }],
  routeVariants: [{ id: "gpt-full", name: "GPT Full", provider: "openai" }],
};

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

describe("loadPreparedModelCatalogSnapshotForBrowse", () => {
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

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({ cfg: config(), loadCatalog }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("uses the full catalog for all views", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({ cfg: config(), view: "all", loadCatalog }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it("uses the read-only catalog when configured visibility has provider wildcards", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config({ providerWildcard: true }),
        loadCatalog,
      }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("uses the full catalog for configured views with provider wildcards", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config({ providerWildcard: true }),
        view: "configured",
        loadCatalog,
      }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it.each([
    ["without picker allowlists", config()],
    ["with provider wildcards", config({ providerWildcard: true })],
  ])("uses the read-only catalog for provider-config views %s", async (_label, cfg) => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({ cfg, view: "provider-config", loadCatalog }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("builds provider-config inventory independently of picker allowlists", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/allowlisted": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            models: [
              { id: "two", name: "Two" },
              { id: "one", name: "One" },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(buildProviderConfigModelCatalogForBrowse({ cfg })).toMatchObject([
      { provider: "openai", id: "one", name: "One" },
      { provider: "openai", id: "two", name: "Two" },
    ]);
  });

  it("returns an empty catalog when read-only catalog loading times out with provider wildcards", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(() => new Promise<ModelCatalogSnapshot>(() => {}));

    const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
      cfg: config({ providerWildcard: true }),
      loadCatalog,
      timeoutMs: 5,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toEqual({ entries: [], routeVariants: [] });
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("uses the default timeout when timeoutMs is non-finite", async () => {
    const onTimeout = vi.fn();
    const setTimeout = vi.spyOn(globalThis, "setTimeout");
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const loadCatalog = vi.fn(async () => readOnlyCatalog);

    const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
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
    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("caps oversized browse timeouts before scheduling the fallback timer", async () => {
    const setTimeout = vi.spyOn(globalThis, "setTimeout");
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const loadCatalog = vi.fn(async () => readOnlyCatalog);

    const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    await expect(resultPromise).resolves.toBe(readOnlyCatalog);
    expect(setTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(clearTimeout).toHaveBeenCalledOnce();
  });
});

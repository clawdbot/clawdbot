import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
/**
 * Regression coverage for model catalog browsing.
 * Verifies filtered catalog output and pending load behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  loadPreparedModelCatalogSnapshotForBrowse,
  MODEL_CATALOG_BROWSE_TIMEOUT_MS,
} from "./model-catalog-browse.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";

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
            modelPolicy: {
              allow: ["openai/*"],
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

  it("uses the full catalog for default views with provider wildcards", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config({ providerWildcard: true }),
        loadCatalog,
      }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
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

  it("keeps automatic wildcard reads on prepared facts", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config({ providerWildcard: true }),
        view: "configured",
        preparedOnly: true,
        loadCatalog,
      }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it.each(["all", "configured"] as const)(
    "forwards explicit %s refresh to full discovery",
    async (view) => {
      const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
        readOnly ? readOnlyCatalog : fullCatalog,
      );

      await expect(
        loadPreparedModelCatalogSnapshotForBrowse({
          cfg: config(),
          view,
          refresh: true,
          loadCatalog,
        }),
      ).resolves.toBe(fullCatalog);

      expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false, refresh: true });
    },
  );

  it("uses the read-only catalog for provider-config views without picker allowlists", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config(),
        view: "provider-config",
        loadCatalog,
      }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("uses the full catalog for provider-config views with provider wildcards", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config({ providerWildcard: true }),
        view: "provider-config",
        loadCatalog,
      }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it("uses the selected agent's provider wildcard", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );
    const cfg = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.6"] } },
        list: [{ id: "research", modelPolicy: { allow: ["litellm/*"] } }],
      },
    } as OpenClawConfig;

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        cfg,
        agentId: "research",
        view: "provider-config",
        loadCatalog,
      }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it("keeps the read-only catalog for default views with legacy models wildcards", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/*": {},
          },
        },
      },
    } as OpenClawConfig;

    await expect(loadPreparedModelCatalogSnapshotForBrowse({ cfg, loadCatalog })).resolves.toBe(
      readOnlyCatalog,
    );

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

  it("returns an empty catalog when read-only catalog loading times out", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(() => new Promise<ModelCatalogSnapshot>(() => {}));

    const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: 5,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toEqual({ entries: [], routeVariants: [] });
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("quietly consumes publication supersession after the browse deadline", async () => {
    vi.useFakeTimers();
    const loadCatalog = vi.fn(
      () =>
        new Promise<ModelCatalogSnapshot>((_resolve, reject) => {
          setTimeout(
            () => reject(new PreparedModelRuntimePublicationSupersededError("late supersession")),
            10,
          );
        }),
    );

    const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: 5,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toEqual({ entries: [], routeVariants: [] });
    await vi.advanceTimersByTimeAsync(5);
  });

  it("can preserve the timeout fallback while escalating to full discovery", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(() => new Promise<ModelCatalogSnapshot>(() => {}));

    const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
      cfg: config({ providerWildcard: true }),
      view: "configured",
      loadCatalog,
      timeoutFullDiscovery: true,
      timeoutMs: 5,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toEqual({ entries: [], routeVariants: [] });
    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
  });

  it.each(["default", "provider-config"] as const)(
    "bounds implicit full discovery for %s wildcard views",
    async (view) => {
      vi.useFakeTimers();
      const onTimeout = vi.fn();
      const loadCatalog = vi.fn(() => new Promise<ModelCatalogSnapshot>(() => {}));

      const resultPromise = loadPreparedModelCatalogSnapshotForBrowse({
        cfg: config({ providerWildcard: true }),
        view,
        loadCatalog,
        timeoutMs: 5,
        onTimeout,
      });

      await vi.advanceTimersByTimeAsync(5);
      await expect(resultPromise).resolves.toEqual({ entries: [], routeVariants: [] });
      expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
      expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
    },
  );

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
      MODEL_CATALOG_BROWSE_TIMEOUT_MS,
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

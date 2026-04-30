import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayModelChoice } from "./server-model-catalog.js";
import {
  __resetModelCatalogCacheForTest,
  loadGatewayModelCatalog,
  markGatewayModelCatalogStaleForReload,
} from "./server-model-catalog.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
type LoadModelCatalogForTest = NonNullable<
  NonNullable<Parameters<typeof loadGatewayModelCatalog>[0]>["loadModelCatalog"]
>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(id: string): GatewayModelChoice {
  return { id, name: id, provider: "openai" } as GatewayModelChoice;
}

const getConfig = () => ({}) as OpenClawConfig;

describe("loadGatewayModelCatalog", () => {
  beforeEach(async () => {
    await __resetModelCatalogCacheForTest();
  });

  it("caches the first successful catalog until reload marks it stale", async () => {
    const catalog = [model("gpt-5.4")];
    const loadModelCatalog = vi.fn(async () => catalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(catalog);
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(catalog);

    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not cache an empty catalog so the next request retries", async () => {
    const emptyCatalog: GatewayModelChoice[] = [];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(emptyCatalog)
      .mockResolvedValueOnce(freshCatalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      emptyCatalog,
    );
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      freshCatalog,
    );

    expect(loadModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("returns the last catalog while a stale reload refresh is still pending", async () => {
    const staleCatalog = [model("gpt-5.4")];
    const freshCatalog = [model("gpt-5.5")];
    const refresh = createDeferred<GatewayModelChoice[]>();
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(staleCatalog)
      .mockReturnValueOnce(refresh.promise);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );

    markGatewayModelCatalogStaleForReload();
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(2));

    refresh.resolve(freshCatalog);
    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
        freshCatalog,
      );
    });
  });

  it("keeps serving the last catalog when a stale background refresh fails", async () => {
    const staleCatalog = [model("gpt-5.4")];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = vi
      .fn<LoadModelCatalogForTest>()
      .mockResolvedValueOnce(staleCatalog)
      .mockRejectedValueOnce(new Error("provider offline"))
      .mockResolvedValueOnce(freshCatalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );

    markGatewayModelCatalogStaleForReload();
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(2));

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      staleCatalog,
    );
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(3));

    await vi.waitFor(async () => {
      await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
        freshCatalog,
      );
    });
  });
});

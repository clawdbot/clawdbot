import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayModelChoice } from "./server-model-catalog.js";
import {
  resetModelCatalogCacheForTest,
  loadGatewayModelCatalog,
  markGatewayModelCatalogStaleForReload,
} from "./server-model-catalog.js";
import { createDeferred } from "./test-helpers.deferred.js";

type LoadModelCatalogForTest = NonNullable<
  NonNullable<Parameters<typeof loadGatewayModelCatalog>[0]>["loadModelCatalog"]
>;

function model(id: string): GatewayModelChoice {
  return { id, name: id, provider: "openai" } as GatewayModelChoice;
}

const getConfig = () => ({}) as OpenClawConfig;

function createRefreshingCatalogLoader(
  firstCatalog: GatewayModelChoice[],
  secondCatalog: GatewayModelChoice[],
) {
  return vi
    .fn<LoadModelCatalogForTest>()
    .mockResolvedValueOnce(firstCatalog)
    .mockResolvedValueOnce(secondCatalog);
}

async function expectCatalog(
  loadModelCatalog: LoadModelCatalogForTest,
  catalog: GatewayModelChoice[],
  readOnly = true,
) {
  await expect(
    loadGatewayModelCatalog({
      getConfig,
      loadModelCatalog,
      ...(readOnly ? {} : { readOnly: false }),
    }),
  ).resolves.toBe(catalog);
}

async function markStaleAndExpectPreviousCatalog(
  loadModelCatalog: LoadModelCatalogForTest,
  catalog: GatewayModelChoice[],
) {
  markGatewayModelCatalogStaleForReload();
  await expectCatalog(loadModelCatalog, catalog);
  await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(2));
}

describe("loadGatewayModelCatalog", () => {
  beforeEach(async () => {
    await resetModelCatalogCacheForTest();
  });

  it("caches the first successful catalog until reload marks it stale", async () => {
    const catalog = [model("gpt-5.4")];
    const loadModelCatalog = vi.fn(async () => catalog);

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(catalog);
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(catalog);

    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
    expect(loadModelCatalog).toHaveBeenCalledWith({ config: getConfig(), readOnly: true });
  });

  it("keeps read-only and full catalog caches separate", async () => {
    const readOnlyCatalog = [model("configured-only")];
    const fullCatalog = [model("configured-only"), model("browse-only")];
    const loadModelCatalog = vi.fn<LoadModelCatalogForTest>(async (params) =>
      params.readOnly === false ? fullCatalog : readOnlyCatalog,
    );

    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      readOnlyCatalog,
    );
    await expect(
      loadGatewayModelCatalog({ getConfig, loadModelCatalog, readOnly: false }),
    ).resolves.toBe(fullCatalog);
    await expect(loadGatewayModelCatalog({ getConfig, loadModelCatalog })).resolves.toBe(
      readOnlyCatalog,
    );

    expect(loadModelCatalog).toHaveBeenCalledTimes(2);
    expect(loadModelCatalog).toHaveBeenNthCalledWith(1, {
      config: getConfig(),
      readOnly: true,
    });
    expect(loadModelCatalog).toHaveBeenNthCalledWith(2, {
      config: getConfig(),
      readOnly: false,
    });
  });

  it("caches an empty read-only catalog until reload marks it stale", async () => {
    const emptyCatalog: GatewayModelChoice[] = [];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = createRefreshingCatalogLoader(emptyCatalog, freshCatalog);

    await expectCatalog(loadModelCatalog, emptyCatalog);
    await expectCatalog(loadModelCatalog, emptyCatalog);

    expect(loadModelCatalog).toHaveBeenCalledTimes(1);

    await markStaleAndExpectPreviousCatalog(loadModelCatalog, emptyCatalog);
    await vi.waitFor(async () => {
      await expectCatalog(loadModelCatalog, freshCatalog);
    });
  });

  it("does not cache an empty full catalog so the next all-model request retries", async () => {
    const emptyCatalog: GatewayModelChoice[] = [];
    const freshCatalog = [model("gpt-5.5")];
    const loadModelCatalog = createRefreshingCatalogLoader(emptyCatalog, freshCatalog);

    await expectCatalog(loadModelCatalog, emptyCatalog, false);
    await expectCatalog(loadModelCatalog, freshCatalog, false);

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

    await expectCatalog(loadModelCatalog, staleCatalog);

    await markStaleAndExpectPreviousCatalog(loadModelCatalog, staleCatalog);

    refresh.resolve(freshCatalog);
    await vi.waitFor(async () => {
      await expectCatalog(loadModelCatalog, freshCatalog);
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

    await expectCatalog(loadModelCatalog, staleCatalog);

    await markStaleAndExpectPreviousCatalog(loadModelCatalog, staleCatalog);

    await expectCatalog(loadModelCatalog, staleCatalog);
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledTimes(3));

    await vi.waitFor(async () => {
      await expectCatalog(loadModelCatalog, freshCatalog);
    });
  });
});

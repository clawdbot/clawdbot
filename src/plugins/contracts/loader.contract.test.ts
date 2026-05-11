import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uniqueSortedStrings } from "../../plugin-sdk/test-helpers/string-utils.js";
import { withBundledPluginAllowlistCompat } from "../bundled-compat.js";
import { resolveManifestContractPluginIds } from "../plugin-registry.js";
import { __testing as providerTesting } from "../providers.js";
import { resolveBundledContractSnapshotPluginIds } from "./inventory/bundled-capability-metadata.js";
import { providerContractCompatPluginIds } from "./registry.js";

function resolveBundledManifestProviderPluginIds() {
  return uniqueSortedStrings(resolveBundledContractSnapshotPluginIds("providerIds"));
}

function expectPluginAllowlistEquals(
  allow: string[] | undefined,
  pluginIds: string[],
  expectedExtraEntry?: string,
) {
  expect(allow).toEqual(expectedExtraEntry ? [expectedExtraEntry, ...pluginIds] : pluginIds);
}

function createAllowlistCompatConfig(pluginIds: string[]) {
  return withBundledPluginAllowlistCompat({
    config: {
      plugins: {
        allow: [demoAllowEntry],
        bundledDiscovery: "compat",
      },
    },
    pluginIds,
  });
}

const demoAllowEntry = "demo-allowed";

describe("plugin loader contract", () => {
  let providerPluginIds: string[] = [];
  let manifestProviderPluginIds: string[] = [];
  let compatPluginIds: string[] = [];
  let compatConfig: ReturnType<typeof withBundledPluginAllowlistCompat>;
  let vitestCompatConfig: ReturnType<typeof providerTesting.withBundledProviderVitestCompat>;
  let webSearchPluginIds: string[] = [];
  let bundledWebSearchPluginIds: string[] = [];
  let webSearchAllowlistCompatConfig: ReturnType<typeof withBundledPluginAllowlistCompat>;

  beforeAll(() => {
    providerPluginIds = uniqueSortedStrings(providerContractCompatPluginIds);
    manifestProviderPluginIds = resolveBundledManifestProviderPluginIds();
    compatPluginIds = providerTesting.resolveBundledProviderCompatPluginIds({
      config: {
        plugins: {
          allow: [demoAllowEntry],
          bundledDiscovery: "compat",
        },
      },
    });
    compatConfig = createAllowlistCompatConfig(compatPluginIds);
    vitestCompatConfig = providerTesting.withBundledProviderVitestCompat({
      config: undefined,
      pluginIds: providerPluginIds,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });
    webSearchPluginIds = uniqueSortedStrings(
      resolveBundledContractSnapshotPluginIds("webSearchProviderIds"),
    );
    bundledWebSearchPluginIds = uniqueSortedStrings(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        origin: "bundled",
      }),
    );
    webSearchAllowlistCompatConfig = createAllowlistCompatConfig(webSearchPluginIds);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps bundled provider compatibility wired to the provider registry", () => {
    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    const sortedCompatPluginIds = uniqueSortedStrings(compatPluginIds);
    expect(sortedCompatPluginIds).toEqual(manifestProviderPluginIds);
    expectPluginAllowlistEquals(compatConfig?.plugins?.allow, providerPluginIds, demoAllowEntry);
  });

  it("keeps vitest bundled provider enablement wired to the provider registry", () => {
    expect(providerPluginIds).toEqual(manifestProviderPluginIds);
    expect(vitestCompatConfig?.plugins?.enabled).toBe(true);
    expectPluginAllowlistEquals(vitestCompatConfig?.plugins?.allow, providerPluginIds);
  });

  it("keeps bundled web search loading scoped to the web search registry", () => {
    expect(bundledWebSearchPluginIds).toEqual(webSearchPluginIds);
  });

  it("keeps bundled web search allowlist compatibility wired to the web search registry", () => {
    expectPluginAllowlistEquals(
      webSearchAllowlistCompatConfig?.plugins?.allow,
      webSearchPluginIds,
      demoAllowEntry,
    );
  });
});

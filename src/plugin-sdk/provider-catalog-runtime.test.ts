import { resolvePluginProviders } from "openclaw/plugin-sdk/provider-catalog-runtime";
import { afterEach, expect, it } from "vitest";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";

afterEach(() => resetPluginLoaderTestStateForTest());

it("resolves an empty provider scope through the shipped SDK export", () => {
  expect(
    resolvePluginProviders({
      config: { plugins: { enabled: false } },
      env: {},
      onlyPluginIds: [],
    }),
  ).toEqual([]);
});

import { runDirectImportSmoke } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("matrix config update import boundary", () => {
  it("updates secret inputs without loading secret setup or resolution", async () => {
    const stdout = await runDirectImportSmoke(`
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const entryUrl = pathToFileURL(realpathSync("./extensions/matrix/src/matrix/config-update.ts")).href;
const watchedUrls = new Map([
  [entryUrl, "entry"],
  [pathToFileURL(realpathSync("./src/secrets/plugin-setup-plan.ts")).href, "setup"],
  [pathToFileURL(realpathSync("./src/secrets/resolve.ts")).href, "resolver"],
]);
const observed = { entry: false, setup: false, resolver: false };
const hooks = registerHooks({
  load(url, context, nextLoad) {
    // Loader query parameters do not change which filesystem owner is loaded.
    const canonicalUrl = new URL(url);
    canonicalUrl.search = "";
    canonicalUrl.hash = "";
    const owner = watchedUrls.get(canonicalUrl.href);
    if (owner) observed[owner] = true;
    return nextLoad(url, context);
  },
});
try {
  const { updateMatrixAccountConfig } = await import(entryUrl);
  const ref = { source: "env", provider: "default", id: "MATRIX_IMPORT_TEST_TOKEN" };
  const updated = updateMatrixAccountConfig({}, "default", {
    accessToken: ref,
    password: "  synthetic-password  ",
  });
  const { hasExplicitMatrixAccountConfig } = await import("./extensions/matrix/src/matrix/account-config.ts");
  process.stdout.write(JSON.stringify({
    observed,
    account: updated.channels.matrix,
    explicitAccount: hasExplicitMatrixAccountConfig({ channels: { matrix: { accessToken: ref } } }, "default"),
  }));
} finally {
  hooks.deregister();
}
`);
    const result = JSON.parse(stdout);
    expect(result.observed.entry).toBe(true);
    expect(result.account).toEqual({
      enabled: true,
      accessToken: { source: "env", provider: "default", id: "MATRIX_IMPORT_TEST_TOKEN" },
      password: "synthetic-password",
    });
    expect(result.explicitAccount).toBe(true);
    expect(
      result.observed,
      "Matrix config updates must not load secret setup or resolver owners",
    ).toEqual({ entry: true, setup: false, resolver: false });
  }, 45_000);
});

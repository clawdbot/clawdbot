import { runDirectImportSmoke } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("googlechat secret contract import boundary", () => {
  it("exposes service-account targets without loading secret setup or resolution", async () => {
    const stdout = await runDirectImportSmoke(`
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const entryUrl = pathToFileURL(realpathSync("./extensions/googlechat/secret-contract-api.ts")).href;
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
  const contract = await import(entryUrl);
  process.stdout.write(JSON.stringify({
    observed,
    collectorCallable: typeof contract.collectRuntimeConfigAssignments === "function",
    targets: contract.secretTargetRegistryEntries.map(
      ({ pathPattern, secretShape, expectedResolvedValue }) =>
        ({ pathPattern, secretShape, expectedResolvedValue }),
    ),
  }));
} finally {
  hooks.deregister();
}
`);
    const result = JSON.parse(stdout);
    expect(result.observed.entry).toBe(true);
    expect(result.collectorCallable).toBe(true);
    expect(result.targets).toEqual(
      expect.arrayContaining([
        {
          pathPattern: "channels.googlechat.serviceAccount",
          secretShape: "secret_input",
          expectedResolvedValue: "string-or-object",
        },
        {
          pathPattern: "channels.googlechat.accounts.*.serviceAccount",
          secretShape: "secret_input",
          expectedResolvedValue: "string-or-object",
        },
      ]),
    );
    expect(
      result.observed,
      "Google Chat metadata must not load secret setup or resolver owners",
    ).toEqual({ entry: true, setup: false, resolver: false });
  }, 45_000);
});

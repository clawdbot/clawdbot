import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

async function runSourceImportSmoke(code: string): Promise<string> {
  const repoRoot = new URL("../../../../", import.meta.url);
  const runtimeArgs = process.versions.bun
    ? ["--tsconfig-override", fileURLToPath(new URL("tsconfig.json", repoRoot))]
    : ["--import", "tsx"];
  const { stdout } = await promisify(execFile)(process.execPath, [...runtimeArgs, "-e", code], {
    cwd: fileURLToPath(repoRoot),
    env: {
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      NODE_PATH: process.env.NODE_PATH,
      PATH: process.env.PATH,
      TERM: process.env.TERM,
    },
    timeout: 40_000,
  });
  return stdout;
}

describe("matrix config update import boundary", () => {
  it("updates secret inputs without loading secret setup or resolution", async () => {
    const stdout = await runSourceImportSmoke(String.raw`
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const entryUrl = pathToFileURL(realpathSync("./extensions/matrix/src/matrix/config-update.ts")).href;
const watchedUrls = new Map([
  [entryUrl, "entry"],
  [pathToFileURL(realpathSync("./src/secrets/plugin-setup-plan.ts")).href, "setup"],
  [pathToFileURL(realpathSync("./src/secrets/resolve.ts")).href, "resolver"],
]);
const observed = { entry: false, setup: false, resolver: false };
let deregister = () => {};
if (process.versions.bun) {
  const { plugin } = await import("bun");
  const paths = [...watchedUrls.keys()].map((url) => fileURLToPath(url));
  const escapedPaths = paths.map((path) => path.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"));
  plugin({
    name: "matrix-config-import-observer",
    setup(build) {
      build.onLoad({ filter: new RegExp("^(?:" + escapedPaths.join("|") + ")$"), namespace: "file" }, async ({ path }) => {
        const owner = watchedUrls.get(pathToFileURL(realpathSync(path)).href);
        if (owner) observed[owner] = true;
        return { contents: new Uint8Array(await Bun.file(path).arrayBuffer()), loader: "ts" };
      });
    },
  });
} else {
  const { registerHooks } = await import("node:module");
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
  deregister = () => hooks.deregister();
}
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
  deregister();
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

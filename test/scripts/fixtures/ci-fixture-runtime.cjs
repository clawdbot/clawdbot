const { syncBuiltinESMExports } = require("node:module");
const { pathToFileURL } = require("node:url");

// Synthetic child fixtures replace builtin methods before loading their owners.
/** @param {string[]} [names] */
exports.syncFixtureBuiltinExports = function syncFixtureBuiltinExports(
  names = ["node:child_process", "node:fs"],
) {
  if (!process.versions.bun) {
    syncBuiltinESMExports();
    return;
  }
  const { mock } = require("bun:test");
  for (const name of names) {
    const builtin = require(name);
    mock.module(name, () => ({ ...builtin, default: builtin }));
  }
};

/** @param {string} preload @param {"node" | "bun"} runtime */
function preloadSpecifier(preload, runtime) {
  const url = pathToFileURL(preload).href;
  if (runtime === "node") {
    return url;
  }
  // BUN_OPTIONS cannot quote paths with spaces; import the original file by URL.
  const loader = Buffer.from(`import ${JSON.stringify(url)};`).toString("base64");
  return `data:text/javascript;base64,${loader}`;
}

/** @param {string} preload */
exports.fixturePreloadArgs = function fixturePreloadArgs(preload) {
  return ["--import", preloadSpecifier(preload, process.versions.bun ? "bun" : "node")];
};

/** @param {string} preload @param {"node" | "bun"} [runtime] */
exports.fixturePreloadEnv = function fixturePreloadEnv(
  preload,
  runtime = process.versions.bun ? "bun" : "node",
) {
  const specifier = preloadSpecifier(preload, runtime);
  return runtime === "bun"
    ? { BUN_OPTIONS: `--preload=${specifier}` }
    : { NODE_OPTIONS: `--import=${specifier}` };
};

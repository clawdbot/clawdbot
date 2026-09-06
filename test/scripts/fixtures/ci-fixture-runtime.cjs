const { syncBuiltinESMExports } = require("node:module");
const { pathToFileURL } = require("node:url");

// Synthetic child fixtures replace builtin methods before loading their owners.
exports.syncFixtureBuiltinExports = function syncFixtureBuiltinExports() {
  if (!process.versions.bun) {
    syncBuiltinESMExports();
    return;
  }
  const { mock } = require("bun:test");
  for (const name of ["node:child_process", "node:fs"]) {
    const builtin = require(name);
    mock.module(name, () => ({ ...builtin, default: builtin }));
  }
};

/** @param {string} preload */
exports.fixturePreloadEnv = function fixturePreloadEnv(preload) {
  const url = pathToFileURL(preload).href;
  if (!process.versions.bun) {
    return { NODE_OPTIONS: `--import=${url}` };
  }
  // BUN_OPTIONS cannot quote paths with spaces; import the original file by URL.
  const loader = Buffer.from(`import ${JSON.stringify(url)};`).toString("base64");
  return { BUN_OPTIONS: `--preload=data:text/javascript;base64,${loader}` };
};

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { runNodeScript } from "../helpers/run-node-script.js";

type NodeResult = Awaited<ReturnType<typeof runNodeScript>>;

export function formatShimResult(result: NodeResult) {
  return `status: ${result.status}\nerror: ${inspect(result.error)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function hasUnjoinedTree(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "processTreeState" in error &&
    error.processTreeState !== "terminated"
  );
}

export const TSX_SHIM_WRAPPERS = [
  "scripts/run-vitest.mjs",
  "scripts/lib/plugin-npm-package-manifest.mjs",
  "scripts/e2e/kitchen-sink-rpc-walk.mjs",
  "scripts/perf/summarize-cpuprofile.mjs",
] as const;

export function writeEsmPluginFixture(fixtureRoot: string) {
  const pluginRoot = path.join(fixtureRoot, "compiled-plugin");
  const dependencyRoot = path.join(pluginRoot, "node_modules", "import-only");
  mkdirSync(dependencyRoot, { recursive: true });
  writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    path.join(dependencyRoot, "package.json"),
    JSON.stringify({ type: "module", exports: { import: "./index.js" } }),
  );
  writeFileSync(path.join(dependencyRoot, "index.js"), 'export const value = "import-only";');
  const pluginPath = path.join(pluginRoot, "index.js");
  writeFileSync(
    pluginPath,
    `export { value } from "import-only";
globalThis.pluginEvaluations = (globalThis.pluginEvaluations ?? 0) + 1;
export const instance = {};
`,
  );
  writeFileSync(
    path.join(pluginRoot, "loader.cjs"),
    'module.exports = { load: () => require("./index.js") };',
  );
  return `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
enum Transformed { Value = "transformed" }
try {
const require = createRequire(${JSON.stringify(pathToFileURL(pluginPath).href)});
const loader = require("./loader.cjs");
const first = loader.load();
const imported = await import(${JSON.stringify(pathToFileURL(pluginPath).href)});
assert.strictEqual(loader.load(), first);
assert.strictEqual(imported.instance, first.instance);
assert.strictEqual(require("./loader.cjs"), loader);
assert.strictEqual(require(${JSON.stringify(path.resolve("packages/normalization-core/src/boolean-coercion.ts"))}).parseBoolean, parseBoolean);
console.log(JSON.stringify({ value: first.value, evaluations: globalThis.pluginEvaluations,
  transformed: Transformed.Value, sourceAlias: parseBoolean(" TRUE ") }));
} catch (error) {
  console.error(error.code + ": " + error.message);
  process.exitCode = 1;
}
`;
}

export async function withShimFixture<T>(
  wrapper: (typeof TSX_SHIM_WRAPPERS)[number],
  run: (paths: {
    checkoutRoot: string;
    fixtureRoot: string;
    implementationPath: string;
    wrapperPath: string;
    runNode: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<NodeResult>;
  }) => T,
) {
  // spawnOwnedVitestProcess gives POSIX Vitest a disposable temp namespace.
  // Own a sibling so unverified writers survive its cleanup, outside repo module resolution.
  // Windows has no enclosing namespace and keeps the ordinary temporary root.
  const fixtureParent = process.platform === "win32" ? tmpdir() : path.dirname(tmpdir());
  const fixtureRoot = realpathSync(mkdtempSync(path.join(fixtureParent, "openclaw-tsx-cli-shim-")));
  const checkoutRoot = path.join(fixtureRoot, "checkout");
  const wrapperPath = path.join(checkoutRoot, wrapper);
  const implementationPath = wrapperPath.replace(
    /\.mjs$/u,
    wrapper === "scripts/run-vitest.mjs" ? "-child.mts" : ".mts",
  );
  const commands: Array<Promise<NodeResult>> = [];
  let outcome: { value: Awaited<T> } | { error: unknown };
  try {
    mkdirSync(path.dirname(wrapperPath), { recursive: true });
    mkdirSync(path.join(checkoutRoot, "scripts", "lib"), { recursive: true });
    copyFileSync(wrapper, wrapperPath);
    copyFileSync("scripts/tsx.mjs", path.join(checkoutRoot, "scripts", "tsx.mjs"));
    copyFileSync(
      "scripts/lib/tsx-cli-shim.mjs",
      path.join(checkoutRoot, "scripts", "lib", "tsx-cli-shim.mjs"),
    );
    copyFileSync(
      "scripts/lib/local-check-runtime.mts",
      path.join(checkoutRoot, "scripts", "lib", "local-check-runtime.mts"),
    );
    writeFileSync(path.join(checkoutRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    outcome = {
      value: await run({
        checkoutRoot,
        fixtureRoot,
        implementationPath,
        wrapperPath,
        runNode(args, env, cwd) {
          const command = runNodeScript(args, env, 10_000, { cwd });
          commands.push(command);
          return command;
        },
      }),
    };
  } catch (error) {
    outcome = { error };
  }
  const callbackError = "error" in outcome ? outcome.error : undefined;
  // Callback rejection must not release files still owned by an in-flight command.
  const results = await Promise.all(commands);
  const unjoined = [callbackError, ...results.map((result) => result.error)].find(hasUnjoinedTree);
  if (unjoined) {
    const outputPath = path.join(fixtureRoot, "command-output.log");
    writeFileSync(outputPath, results.map(formatShimResult).join("\n\n"));
    throw new Error(
      `Child cleanup unverified; retained fixture ${fixtureRoot} and output ${outputPath}. Stop remaining writers before removing this directory.`,
      {
        cause:
          callbackError && callbackError !== unjoined
            ? new AggregateError([callbackError, unjoined])
            : unjoined,
      },
    );
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

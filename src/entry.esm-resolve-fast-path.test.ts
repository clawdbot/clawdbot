import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { installDistEsmResolveFastPath } from "./entry.esm-resolve-fast-path.js";

type ResolveHook = (
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] },
  nextResolve: (specifier: string) => { url: string },
) => { url: string; format?: string | null; shortCircuit?: boolean };

const DIST_ROOT = "file:///opt/openclaw/dist/";
const DIST_ENTRY_PATH = path.resolve("dist/entry.js");
const DIST_INDEX_PATH = path.resolve("dist/index.js");

function installCapturedHook(entryFileUrl: string): ResolveHook {
  let hook: ResolveHook | undefined;
  const installed = installDistEsmResolveFastPath(entryFileUrl, {
    registerHooks: (options) => {
      hook = options.resolve as ResolveHook;
      return { deregister: () => {} };
    },
    execArgv: [],
    nodeOptions: undefined,
  });
  expect(installed).toBe(true);
  if (!hook) {
    throw new Error("resolve hook was not registered");
  }
  return hook;
}

function runHook(
  hook: ResolveHook,
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] } = {},
) {
  const resolvedContext = {
    parentURL: "parentURL" in context ? context.parentURL : `${DIST_ROOT}entry.js`,
    conditions: context.conditions ?? ["node", "import"],
  };
  let deferred = false;
  const result = hook(specifier, resolvedContext, () => {
    deferred = true;
    return { url: "next:resolved" };
  });
  return { deferred, result };
}

describe("installDistEsmResolveFastPath resolve hook", () => {
  const hook = installCapturedHook(`${DIST_ROOT}entry.js`);

  it("short-circuits dist-internal relative .js imports with module format", () => {
    const direct = runHook(hook, "./chunk-abc.js");
    expect(direct.deferred).toBe(false);
    expect(direct.result).toStrictEqual({
      url: `${DIST_ROOT}chunk-abc.js`,
      format: "module",
      shortCircuit: true,
    });
    const fromExtension = runHook(hook, "../../plugin-entry.js", {
      parentURL: `${DIST_ROOT}extensions/telegram/index.js`,
    });
    expect(fromExtension.result.url).toBe(`${DIST_ROOT}plugin-entry.js`);
  });

  it("defers require() resolutions to the default CJS path", () => {
    expect(runHook(hook, "./chunk.js", { conditions: ["node", "require"] }).deferred).toBe(true);
  });

  it("defers bare, absolute, and non-.js specifiers", () => {
    for (const specifier of [
      "openclaw/plugin-sdk/plugin-entry",
      "node:path",
      "/opt/openclaw/dist/chunk.js",
      "./chunk.mjs",
      "./chunk.cjs",
      "./manifest.json",
      "./chunk.js?query",
      ".js",
    ]) {
      expect(runHook(hook, specifier).deferred, specifier).toBe(true);
    }
  });

  it("defers parents outside the dist root and missing parents", () => {
    expect(runHook(hook, "./chunk.js", { parentURL: "file:///opt/other/entry.js" }).deferred).toBe(
      true,
    );
    expect(runHook(hook, "./chunk.js", { parentURL: undefined }).deferred).toBe(true);
  });

  it("defers relative targets that escape the dist root", () => {
    expect(runHook(hook, "../outside/chunk.js").deferred).toBe(true);
  });
});

describe("installDistEsmResolveFastPath gating", () => {
  it("registers one hook per dist root and stays idempotent", () => {
    let registered = 0;
    const registerHooks = () => {
      registered += 1;
      return { deregister: () => {} };
    };
    const root = "file:///opt/openclaw-idempotent/dist/";
    const deps = {
      registerHooks,
      execArgv: ["--trace-warnings"],
      nodeOptions: "--max-old-space-size=4096",
    };
    expect(installDistEsmResolveFastPath(`${root}entry.js`, deps)).toBe(true);
    expect(installDistEsmResolveFastPath(`${root}index.js`, deps)).toBe(true);
    expect(registered).toBe(1);
  });

  it("declines outside dist layouts and without registerHooks support", () => {
    let registered = 0;
    const registerHooks = () => {
      registered += 1;
      return { deregister: () => {} };
    };
    expect(
      installDistEsmResolveFastPath("file:///opt/openclaw/src/entry.ts", { registerHooks }),
    ).toBe(false);
    expect(registered).toBe(0);
    expect(
      installDistEsmResolveFastPath("file:///opt/openclaw-two/dist/entry.js", {
        registerHooks: undefined,
        execArgv: [],
        nodeOptions: undefined,
      }),
    ).toBe(false);
  });

  it.each([
    ["--import", ["--import", "./hook.mjs"]],
    ["--require", ["--require=./hook.cjs"]],
    ["-r", ["-r", "./hook.cjs"]],
    ["--loader", ["--loader=./hook.mjs"]],
    ["--experimental-loader", ["--experimental_loader", "./hook.mjs"]],
    ["--experimental-config-file", ["--experimental_config_file=./node.config.json"]],
    ["--experimental-default-config-file", ["--experimental_default_config_file"]],
    ["--snapshot-blob", ["--snapshot_blob=./snapshot.blob"]],
  ])("declines when execArgv contains %s", (_name, execArgv) => {
    let registered = 0;
    const installed = installDistEsmResolveFastPath(
      `file:///opt/openclaw-preload-${execArgv[0]}/dist/entry.js`,
      {
        registerHooks: () => {
          registered += 1;
          return { deregister: () => {} };
        },
        execArgv,
        nodeOptions: undefined,
      },
    );

    expect(installed).toBe(false);
    expect(registered).toBe(0);
  });

  it.each([
    '--im"port" "./hook.mjs"',
    '"--im\\port" "./hook.mjs"',
    "--experimental_loader ./hook.mjs",
    "--experimental_config_file=./node.config.json",
  ])("declines for parsed NODE_OPTIONS %j", (nodeOptions) => {
    let registered = 0;
    const installed = installDistEsmResolveFastPath(
      `file:///opt/openclaw-node-options-${registered}-${nodeOptions.length}/dist/entry.js`,
      {
        registerHooks: () => {
          registered += 1;
          return { deregister: () => {} };
        },
        execArgv: [],
        nodeOptions,
      },
    );

    expect(installed).toBe(false);
    expect(registered).toBe(0);
  });

  it.each(['"--import ./hook.mjs', '"--import ./hook.mjs\\'])(
    "declines for malformed NODE_OPTIONS %j",
    (nodeOptions) => {
      let registered = 0;
      expect(
        installDistEsmResolveFastPath(
          `file:///opt/openclaw-malformed-${nodeOptions.length}/dist/entry.js`,
          {
            registerHooks: () => {
              registered += 1;
              return { deregister: () => {} };
            },
            execArgv: [],
            nodeOptions,
          },
        ),
      ).toBe(false);
      expect(registered).toBe(0);
    },
  );
});

describe.skipIf(!fs.existsSync(DIST_ENTRY_PATH) || !fs.existsSync(DIST_INDEX_PATH))(
  "built dist resolver hook chaining",
  () => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);

    it.each([
      {
        name: "synchronous preload",
        entryPath: DIST_ENTRY_PATH,
        nodeOption: "--import",
        argv: ["--version"],
        targetPrefix: "./runtime-guard-",
        registerSource: "registerHooks({ resolve: recordTarget });",
      },
      {
        name: "asynchronous loader",
        entryPath: DIST_INDEX_PATH,
        nodeOption: "--loader",
        argv: ["--help"],
        targetPrefix: "./runtime-",
        registerSource:
          "export async function resolve(specifier, context, nextResolve) { return recordTarget(specifier, context, nextResolve); }",
      },
      {
        name: "split-quoted NODE_OPTIONS preload",
        entryPath: DIST_ENTRY_PATH,
        nodeOption: "--import",
        nodeOptions: true,
        argv: ["--version"],
        targetPrefix: "./runtime-guard-",
        registerSource: "registerHooks({ resolve: recordTarget });",
      },
    ])(
      "preserves $name resolver hooks",
      ({ entryPath, nodeOption, nodeOptions, argv, targetPrefix, registerSource }) => {
        const root = tempDirs.make("openclaw-dist-resolver-hook-");
        const hookPath = path.join(root, "resolver-hook.mjs");
        const markerPath = path.join(root, "resolver-hook.log");
        fs.writeFileSync(
          hookPath,
          `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
function recordTarget(specifier, context, nextResolve) {
  if (specifier.startsWith(${JSON.stringify(targetPrefix)}) && specifier.endsWith(".js")) {
    appendFileSync(process.env.OPENCLAW_TEST_RESOLVER_HOOK_MARKER, specifier + "\\n");
  }
  return nextResolve(specifier, context);
}
${registerSource}
`,
        );
        const hookUrl = pathToFileURL(hookPath).href;
        const nodeArgs = nodeOptions
          ? [entryPath, ...argv]
          : [nodeOption, hookUrl, entryPath, ...argv];

        const result = spawnSync(process.execPath, nodeArgs, {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            NODE_DISABLE_COMPILE_CACHE: "1",
            NODE_ENV: undefined,
            NODE_OPTIONS: nodeOptions ? `--im"port" "${hookUrl}"` : undefined,
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_TEST_RESOLVER_HOOK_MARKER: markerPath,
            VITEST: undefined,
          },
        });

        expect(result.status, result.stderr).toBe(0);
        expect(fs.existsSync(markerPath), result.stderr).toBe(true);
        const resolvedTargets = fs.readFileSync(markerPath, "utf8").trim().split("\n");
        expect(resolvedTargets.length).toBeGreaterThan(0);
        expect(resolvedTargets.every((specifier) => specifier.startsWith(targetPrefix))).toBe(true);
      },
    );
  },
);

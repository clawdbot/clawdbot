// Tsdown config tests protect package artifact build contracts.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import { WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID } from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { importFreshModule } from "../../src/plugin-sdk/test-helpers/import-fresh.js";
import buildConfigs from "../../tsdown.config.ts";
import { copyFsSafePackageFixture } from "./fs-safe-package.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
const { createTempDir } = createScriptTestHarness();
afterEach(() => vi.unstubAllEnvs());

type TsdownConfig = (typeof configs)[number];
type OutExtensions = NonNullable<TsdownConfig["outExtensions"]>;

function hasWorkerEntry(config: TsdownConfig, name: string, source: string): boolean {
  const entry = config.entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>)[name] === source;
}

const isWorkerDeployConfig = (config: TsdownConfig) =>
  hasWorkerEntry(config, "worker/worker", "src/worker/worker-deploy-entry.ts");
const isWorkerRsyncReceiverConfig = (config: TsdownConfig) =>
  hasWorkerEntry(
    config,
    "worker/workspace-rsync-receiver",
    "src/worker/workspace-rsync-receiver.ts",
  );
const isWorkerGitHubExecLauncherConfig = (config: TsdownConfig) =>
  hasWorkerEntry(config, "worker/github-exec-launcher", "src/agents/github-exec-launcher.ts");
const isWorkerBuildConfig = (config: TsdownConfig) =>
  isWorkerDeployConfig(config) ||
  isWorkerRsyncReceiverConfig(config) ||
  isWorkerGitHubExecLauncherConfig(config);

const FS_SAFE_CALLER_PROBE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [entry, observer, rootDir, mode, outcome] = process.argv.slice(1);
const { root } = await import(pathToFileURL(entry).href);
const { configureFsSafeNative, getFsSafeNativeConfig, FsSafeError } = await import(pathToFileURL(observer).href);
assert.equal(getFsSafeNativeConfig().mode, mode === "configured" ? "off" : mode);
if (mode === "configured") configureFsSafeNative({ mode: "require" });
const scoped = await root(rootDir);
if (outcome === "missing") {
  await assert.rejects(scoped.write("proof.txt", "native proof"), (error) => {
    assert(error instanceof FsSafeError);
    assert.equal(error.code, "helper-unavailable");
    assert.equal(error.cause?.code, "MODULE_NOT_FOUND");
    return true;
  });
  assert.deepEqual(fs.readdirSync(rootDir), []);
} else {
  await scoped.write("proof.txt", "native proof");
  await scoped.create("created.txt", "create proof");
  assert.equal(fs.readFileSync(path.join(rootDir, "proof.txt"), "utf8"), "native proof");
  assert.equal(fs.readFileSync(path.join(rootDir, "created.txt"), "utf8"), "create proof");
}
const loaded = Object.keys(createRequire(import.meta.url).cache).filter((file) => file.endsWith("fs-safe-native.node"));
assert.equal(loaded.length, outcome === "native" ? 1 : 0);
if (loaded.length) assert(loaded[0].startsWith(path.dirname(rootDir) + path.sep));
`;

describe("tsdown config", () => {
  it.each([false, true])(
    "runs the Docker-selected memory store with only production dependencies (verbose=%s)",
    async (verbose) => {
      vi.stubEnv("OPENCLAW_BUILD_VERBOSE", verbose ? "1" : "0");
      const entryName = "extensions/memory-lancedb/lancedb-store";
      const defaultConfig = configs.find((config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP);
      expect(defaultConfig?.entry).not.toHaveProperty(entryName);
      vi.stubEnv(DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV, "memory-lancedb");
      // Selection is captured during config evaluation; keep the default graph untouched.
      const { default: selectedConfigs } = await importFreshModule<
        typeof import("../../tsdown.config.ts")
      >(import.meta.url, `../../tsdown.config.ts?docker-memory-lancedb=${verbose}`);
      const selected = selectedConfigs.find(
        (config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP,
      );
      const source = (selected?.entry as Record<string, string> | undefined)?.[entryName];
      expect(source).toBeDefined();
      const root = fs.realpathSync(createTempDir("openclaw-tsdown-memory-"));
      const manifest = JSON.parse(
        fs.readFileSync("extensions/memory-lancedb/package.json", "utf8"),
      ) as {
        dependencies: Record<string, string>;
        optionalDependencies: Record<string, string>;
      };
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      for (const name of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      })) {
        const installed = path.resolve("extensions/memory-lancedb/node_modules", name);
        if (!fs.existsSync(installed)) {
          continue;
        }
        const destination = path.join(root, "node_modules", name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(fs.realpathSync(installed), destination, "dir");
      }
      const bundles = await build({
        ...selected,
        config: false,
        entry: { [entryName]: source! },
        outDir: path.join(root, "dist"),
        dts: false,
        logLevel: "silent",
      });
      try {
        const script = `
          import assert from "node:assert/strict";
          import { registerHooks } from "node:module";
          import path from "node:path";
          import { pathToFileURL } from "node:url";
          const [root, entry, bindingsJson] = process.argv.slice(1);
          const bindings = new Set(JSON.parse(bindingsJson));
          const loadedBindings = new Set();
          registerHooks({ resolve(specifier, context, nextResolve) {
            assert(!["@lancedb/lancedb", "@huggingface/transformers", "sharp"].includes(specifier),
              "Unexpected runtime dependency: " + specifier);
            if (bindings.has(specifier)) loadedBindings.add(specifier);
            return nextResolve(specifier, context);
          } });
          const { MemoryDB } = await import(pathToFileURL(entry).href);
          const dbPath = path.join(root, "memory-db");
          let db = new MemoryDB(dbPath, 2);
          try {
            const stored = await db.store("alpha", {
              text: "Bundled memory proof", vector: [1, 0], importance: 0.8, category: "fact"
            });
            assert.equal((await db.search("alpha", [1, 0], 1, 0))[0].entry.id, stored.id);
            assert.deepEqual(await db.search("beta", [1, 0], 1, 0), []);
            db.close();
            db = new MemoryDB(dbPath, 2);
            assert.equal((await db.search("alpha", [1, 0], 1, 0))[0].entry.id, stored.id);
            assert.equal(await db.count("alpha"), 1);
            assert(loadedBindings.size > 0, "Expected a declared native binding");
          } finally {
            db.close();
          }
          console.log("bundled memory store persists and recalls without image dependencies");
        `;
        const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
          (resolve) => {
            execFile(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                script,
                root,
                path.join(root, "dist", `${entryName}.js`),
                JSON.stringify(Object.keys(manifest.optionalDependencies)),
              ],
              { cwd: root, timeout: 30_000 },
              (error, stdout, stderr) => resolve({ error, stdout, stderr }),
            );
          },
        );
        expect(result.error, result.stderr).toBeNull();
        expect(result.stdout.trim()).toBe(
          "bundled memory store persists and recalls without image dependencies",
        );
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    },
  );

  it("builds retained config repairs without plugin runtime or state migration closures", async () => {
    const selected = configs.find((config) => config.outDir === "dist/config-doctor");
    expect(selected?.name).toBe(TSDOWN_UNIFIED_CONFIG_GROUP);
    const entries = selected?.entry ?? {};
    expect(Object.keys(entries)).toContain("discord");
    const root = fs.realpathSync(createTempDir("openclaw-retained-config-doctors-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const bundles = await build({
      ...selected,
      config: false,
      outDir: root,
      dts: false,
      logLevel: "silent",
    });
    try {
      const chunks = new Map(
        bundles.flatMap((bundle) =>
          bundle.chunks
            .filter((chunk) => chunk.type === "chunk")
            .map((chunk) => [chunk.fileName, chunk] as const),
        ),
      );
      const queue = Object.keys(entries).map((entry) => `${entry}.js`);
      const visited = new Set<string>();
      const dependencies = JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies;
      while (queue.length) {
        const name = queue.pop()!;
        if (visited.has(name)) {
          continue;
        }
        visited.add(name);
        const chunk = chunks.get(name);
        if (!chunk) {
          throw new Error(`Missing retained config chunk: ${name}`);
        }
        for (const specifier of chunk.imports) {
          const target = specifier.startsWith(".")
            ? path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
            : specifier;
          if (chunks.has(target)) {
            queue.push(target);
            continue;
          }
          if (isBuiltin(specifier)) {
            continue;
          }
          const packageName = specifier
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/");
          expect(Object.hasOwn(dependencies, packageName), specifier).toBe(true);
          const destination = path.join(root, "node_modules", packageName);
          if (!fs.existsSync(destination)) {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.symlinkSync(
              fs.realpathSync(path.join("node_modules", packageName)),
              destination,
              "dir",
            );
          }
        }
        expect(chunk.code).not.toMatch(
          /migrateLegacyState|openPluginStateKeyedStore|openChannelIngressQueue/u,
        );
        const renderedModules = Object.entries(chunk.modules)
          .filter(([, module]) => module.renderedLength > 0)
          .map(([module]) => module.replaceAll("\\", "/"));
        expect(
          renderedModules.filter((module) =>
            /\/extensions\/[^/]+\/(?:doctor-contract-api|runtime|index|channel-entry|setup-entry)\.[cm]?[jt]s$/u.test(
              module,
            ),
          ),
        ).toEqual([]);
      }
      const script = `
        import assert from "node:assert/strict";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        const [root, entriesJson] = process.argv.slice(1);
        const modules = {};
        for (const name of JSON.parse(entriesJson)) {
          const mod = await import(pathToFileURL(path.join(root, name + ".js")).href);
          assert.deepEqual(Object.keys(mod).sort(), name === "clickclack"
            ? ["normalizeCompatibilityConfig"]
            : ["legacyConfigRules", "normalizeCompatibilityConfig"]);
          modules[name] = mod;
        }
        const cfg = { channels: { discord: { dm: { enabled: true, policy: "allowlist", allowFrom: ["123"] }, accounts: { work: { dm: { policy: "disabled", allowFrom: ["456"] } } } } }, plugins: { allow: [] } };
        const before = structuredClone(cfg);
        const migrated = modules.discord.normalizeCompatibilityConfig({ cfg }).config;
        assert.deepEqual(cfg, before);
        assert.deepEqual(migrated.channels.discord.dm, { enabled: true });
        assert.equal(migrated.channels.discord.dmPolicy, "allowlist");
        assert.deepEqual(migrated.channels.discord.allowFrom, ["123"]);
        assert.equal(migrated.channels.discord.accounts.work.dmPolicy, "disabled");
        assert.deepEqual(migrated.channels.discord.accounts.work.allowFrom, ["456"]);
        assert.deepEqual(migrated.plugins, { allow: [] });
        for (const name of ["imessage", "msteams"]) {
          const result = modules[name].normalizeCompatibilityConfig({ cfg: { channels: { [name]: { blockStreaming: false } } } });
          assert.equal(result.config.channels[name].streaming.block.enabled, false);
          assert.equal(Object.hasOwn(result.config.channels[name], "blockStreaming"), false);
        }
        console.log("retained config APIs migrate without plugin installation or capability grants");
      `;
      const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["--input-type=module", "-e", script, root, JSON.stringify(Object.keys(entries))],
            { cwd: root, timeout: 30_000 },
            (error, stdout, stderr) => resolve({ error, stdout, stderr }),
          );
        },
      );
      expect(result.error, result.stderr).toBeNull();
      expect(result.stdout.trim()).toBe(
        "retained config APIs migrate without plugin installation or capability grants",
      );
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });

  it.each(["runtime", "worker"])(
    "preserves fs-safe package ownership and policy in relocated %s output",
    async (target) => {
      const temporaryRoot = fs.realpathSync(createTempDir("openclaw-tsdown-fs-safe-"));
      const sourceRoot = path.join(temporaryRoot, "build");
      const relocatedRoot = path.join(temporaryRoot, "relocated");
      fs.mkdirSync(sourceRoot);
      fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"type":"module"}');
      const worker = target === "worker";
      const require = createRequire(import.meta.url);
      const { nativePackages } = worker
        ? { nativePackages: [] }
        : copyFsSafePackageFixture(sourceRoot);
      if (!worker) {
        expect(nativePackages.length).toBeGreaterThan(0);
      }
      const sdkSource = path.resolve("src/plugin-sdk/memory-core-host-engine-fs.ts");
      const observerSource = path.join(sourceRoot, "observer.ts");
      fs.writeFileSync(
        observerSource,
        [
          ...(worker
            ? [`import ${JSON.stringify(path.resolve("src/worker/worker-deploy-runtime.ts"))};`]
            : []),
          `export { root } from ${JSON.stringify(sdkSource)};`,
          `export { configureFsSafeNative, getFsSafeNativeConfig } from ${JSON.stringify(worker ? require.resolve("@openclaw/fs-safe/config") : "@openclaw/fs-safe/config")};`,
          `export { FsSafeError } from ${JSON.stringify(worker ? require.resolve("@openclaw/fs-safe/errors") : "@openclaw/fs-safe/errors")};`,
        ].join("\n"),
      );
      const selected = configs.find(
        worker ? isWorkerDeployConfig : (config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP,
      );
      expect(selected).toBeDefined();
      const bundles = await build({
        ...selected,
        config: false,
        entry: worker
          ? { "worker/worker": observerSource }
          : { "plugin-sdk/memory-core-host-engine-fs": sdkSource, observer: observerSource },
        outDir: path.join(sourceRoot, "output"),
        dts: false,
        logLevel: "silent",
      });
      try {
        fs.renameSync(sourceRoot, relocatedRoot);
        const entry = path.join(
          relocatedRoot,
          worker ? "output/worker/worker.mjs" : "output/plugin-sdk/memory-core-host-engine-fs.js",
        );
        const observer = worker ? entry : path.join(relocatedRoot, "output/observer.js");
        const probe = async (
          name: string,
          mode: string,
          outcome: string,
          override: NodeJS.ProcessEnv = {},
        ) => {
          const rootDir = path.join(relocatedRoot, name);
          fs.mkdirSync(rootDir);
          const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
            (resolve) => {
              execFile(
                process.execPath,
                [
                  "--input-type=module",
                  "--eval",
                  FS_SAFE_CALLER_PROBE,
                  entry,
                  observer,
                  rootDir,
                  mode,
                  outcome,
                ],
                {
                  cwd: relocatedRoot,
                  encoding: "utf8",
                  timeout: 30_000,
                  env: {
                    PATH: process.env.PATH,
                    SystemRoot: process.env.SystemRoot,
                    WINDIR: process.env.WINDIR,
                    HOME: temporaryRoot,
                    USERPROFILE: temporaryRoot,
                    TMPDIR: temporaryRoot,
                    TMP: temporaryRoot,
                    TEMP: temporaryRoot,
                    ...override,
                  },
                },
                (error, stdout, stderr) => resolve({ error, stdout, stderr }),
              );
            },
          );
          expect(result.error, `${name}\n${result.stdout}\n${result.stderr}`).toBeNull();
        };
        // Join every caller before removing its dependency tree, even after a failure.
        const join = async (probes: Promise<void>[]) => {
          const results = await Promise.allSettled(probes);
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length) {
            throw new AggregateError(errors, "fs-safe package probes failed");
          }
        };
        if (worker) {
          await join([
            probe("default", "off", "fallback"),
            ...["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"].map((key) =>
              probe(key, "off", "fallback", { [key]: "require" }),
            ),
          ]);
        } else {
          await join([
            ...["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"].map((key) =>
              probe(key, "require", "native", { [key]: "require" }),
            ),
            probe("shared-config", "configured", "native"),
            probe("default", "off", "fallback"),
          ]);
          for (const nativePackage of nativePackages) {
            fs.rmSync(path.join(relocatedRoot, path.relative(sourceRoot, nativePackage.root)), {
              recursive: true,
            });
          }
          await join([
            probe("missing", "require", "missing", { FS_SAFE_NATIVE_MODE: "require" }),
            ...["off", "auto"].map((mode) =>
              probe(mode, mode, "fallback", { FS_SAFE_NATIVE_MODE: mode }),
            ),
          ]);
        }
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    },
  );

  it.each(
    ["runtime", "declarations", "worker", "receiver", "github-launcher"].flatMap((target) =>
      [false, true].map((verbose) => ({ target, verbose })),
    ),
  )(
    "preserves dependency package boundaries for $target (verbose=$verbose)",
    async ({ target, verbose }) => {
      vi.stubEnv("OPENCLAW_BUILD_VERBOSE", verbose ? "1" : "0");
      const root = fs.realpathSync(createTempDir("openclaw-tsdown-dependencies-"));
      const declarations = target === "declarations";
      const bundleAll = ["worker", "receiver", "github-launcher"].includes(target);
      const selected = configs.find(
        target === "worker"
          ? isWorkerDeployConfig
          : target === "receiver"
            ? isWorkerRsyncReceiverConfig
            : target === "github-launcher"
              ? isWorkerGitHubExecLauncherConfig
              : (entry) =>
                  entry.name ===
                  (declarations
                    ? TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0]
                    : TSDOWN_UNIFIED_CONFIG_GROUP),
      );
      expect(selected).toBeDefined();
      const packages = [
        "@anthropic-ai/vertex-sdk",
        "@slack/bolt",
        "@slack/web-api",
        "@discordjs/voice",
        "@lancedb/lancedb",
        "@larksuiteoapi/node-sdk",
        "@matrix-org/matrix-sdk-crypto-nodejs",
        "@openclaw/ai",
        "@openclaw/crabline",
        "@openclaw/fs-safe",
        "@vitest/expect",
        "jimp",
        "matrix-js-sdk",
        "prism-media",
        "typescript",
        "vitest",
        "zod",
        ...Object.keys(
          JSON.parse(fs.readFileSync("extensions/memory-lancedb/package.json", "utf8"))
            .optionalDependencies,
        ),
      ];
      // No manifest dependencies: only phantom/transitive copies are resolvable.
      // Automatic manifest externalization must not hide a missing build boundary.
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      const specifiers: string[] = [];
      const expectedImports: string[] = [];
      for (const name of packages) {
        for (const packageName of [name, `${name}-extra`]) {
          const packageRoot = path.join(root, "node_modules", packageName);
          fs.mkdirSync(packageRoot, { recursive: true });
          fs.writeFileSync(
            path.join(packageRoot, "package.json"),
            JSON.stringify({
              name: packageName,
              version: "1.0.0",
              type: "module",
              exports: {
                ".": { types: "./index.d.ts", default: "./index.js" },
                "./subpath": { types: "./index.d.ts", default: "./index.js" },
              },
            }),
          );
          fs.writeFileSync(
            path.join(packageRoot, "index.js"),
            "export const identity = import.meta.url;\n",
          );
          fs.writeFileSync(
            path.join(packageRoot, "index.d.ts"),
            "export interface Identity { value: string }\n",
          );
          const imports = [packageName, `${packageName}/subpath`];
          specifiers.push(...imports);
          if (
            !bundleAll &&
            packageName === name &&
            name !== "@lancedb/lancedb" &&
            name !== "@openclaw/crabline" &&
            (name !== "zod" || declarations)
          ) {
            expectedImports.push(...imports);
          }
        }
      }
      const entry = path.join(root, declarations ? "entry.d.ts" : "entry.ts");
      fs.writeFileSync(
        entry,
        specifiers
          .map(
            (specifier, index) =>
              `export { ${declarations ? "type Identity" : "identity"} as value${index} } from ${JSON.stringify(specifier)};`,
          )
          .join("\n"),
      );
      const bundles = await build({
        ...selected,
        config: false,
        cwd: root,
        entry: [entry],
        outDir: path.join(root, "dist"),
        tsconfig: false,
        dts: declarations ? { emitDtsOnly: true } : false,
        logLevel: "silent",
      });
      try {
        const imports = bundles.flatMap((bundle) =>
          bundle.chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.imports : [])),
        );
        expect(imports.toSorted()).toEqual(expectedImports.toSorted());
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    },
  );

  it.each(["tsdown.config.ts", "tsdown.ai.config.ts"])(
    "keeps %s free of runtime imports from tsdown",
    (configPath) => {
      const source = fs.readFileSync(configPath, "utf8");
      expect(source).not.toMatch(/^import(?!\s+type\b).*from ["']tsdown["'];?$/mu);
    },
  );

  it("isolates runtime output from bounded declaration-only graphs", () => {
    const packageConfigs = configs.filter((entry) => entry.name === TSDOWN_PACKAGE_CONFIG_GROUP);
    const unifiedRuntimeConfig = configs.find(
      (entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP,
    );
    const unifiedDeclarationConfigs = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.map((name) =>
      configs.find((entry) => entry.name === name),
    );

    expect(packageConfigs).not.toHaveLength(0);
    expect(packageConfigs.map((entry) => entry.dts)).toEqual(packageConfigs.map(() => true));
    expect(unifiedRuntimeConfig?.dts).toBe(false);
    expect(unifiedDeclarationConfigs.every(Boolean)).toBe(true);
    for (const declarationConfig of unifiedDeclarationConfigs) {
      expect(declarationConfig?.dts).toMatchObject({ emitDtsOnly: true });
      expect(Object.keys(declarationConfig?.entry ?? {})).toEqual(
        Object.keys(unifiedRuntimeConfig?.entry ?? {}),
      );
    }
  });

  it("keeps excluded plugins out of the unified graph without dropping host helpers", () => {
    const runtime = configs.find((entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP);
    const entries = runtime?.entry as Record<string, string>;
    const excluded = collectRootPackageExcludedExtensionDirs();
    expect(
      Object.keys(entries).filter(
        (name) => name.startsWith("extensions/") && excluded.has(name.split("/")[1]!),
      ),
    ).toEqual([]);
    expect(entries["plugin-sdk/codex-mcp-projection"]).toBe(
      "src/plugin-sdk/codex-mcp-projection.ts",
    );
    expect(entries["plugin-sdk/codex-session-transcript-runtime"]).toBe(
      "src/plugin-sdk/codex-session-transcript-runtime.ts",
    );
    expect(entries["plugins/public-surface-runtime"]).toBe("src/plugins/public-surface-runtime.ts");
    expect(Object.values(entries)).toEqual(
      expect.arrayContaining([
        "extensions/vault/vault-secret-id.js",
        "extensions/vault/vault-secret-ref-resolver.js",
      ]),
    );
  });

  it("emits bounded public declarations without private runtime roots", () => {
    const declarationSources = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.flatMap((name) => {
      const declarationConfig = configs.find((entry) => entry.name === name);
      const dts = declarationConfig?.dts;
      if (!dts || typeof dts !== "object" || !Array.isArray(dts.entry)) {
        return [];
      }
      expect(dts.entry.length).toBeLessThanOrEqual(200);
      return dts.entry;
    });

    expect(declarationSources).toEqual(
      expect.arrayContaining([
        "src/index.ts",
        ...publicPluginSdkEntrypoints.map((entry) => `src/plugin-sdk/${entry}.ts`),
        "extensions/anthropic/api.ts",
        "extensions/anthropic/contract-api.ts",
        "extensions/memory-core/api.ts",
        "extensions/memory-core/runtime-api.ts",
      ]),
    );
    expect(
      declarationSources.filter(
        (source) => source.startsWith("src/") && !source.startsWith("src/plugin-sdk/"),
      ),
    ).toEqual(["src/index.ts"]);
    expect(
      declarationSources.filter((source) => source.startsWith("extensions/anthropic/")).toSorted(),
    ).toEqual(["extensions/anthropic/api.ts", "extensions/anthropic/contract-api.ts"]);
    expect(declarationSources.every((source) => /\.[cm]?tsx?$/u.test(source))).toBe(true);
    expect(new Set(declarationSources).size).toBe(declarationSources.length);
  });

  it("keeps public SDK types canonical without emitting private runtime declarations", () => {
    const [publicDeclarationSources = [], privateDeclarationSources = []] =
      TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.filter((name) =>
        name.startsWith("openclaw-dts-plugin-sdk-"),
      ).map((name) => {
        const dts = configs.find((entry) => entry.name === name)?.dts;
        return dts && typeof dts === "object" && Array.isArray(dts.entry) ? dts.entry : [];
      });
    const publicSources = publicPluginSdkEntrypoints.map((entry) => `src/plugin-sdk/${entry}.ts`);
    expect(publicDeclarationSources.toSorted()).toEqual(publicSources.toSorted());
    expect(privateDeclarationSources).toEqual([]);
    const runtime = configs.find((entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP);
    expect(runtime?.entry).toHaveProperty(
      "plugin-sdk/tts-runtime",
      "src/plugin-sdk/tts-runtime.ts",
    );
  });

  it("builds self-contained worker deploy executables with every dependency bundled", () => {
    const workerConfig = configs.find(isWorkerDeployConfig);
    const receiverConfig = configs.find(isWorkerRsyncReceiverConfig);
    const launcherConfig = configs.find(isWorkerGitHubExecLauncherConfig);
    expect(workerConfig?.entry).toEqual({
      "worker/worker": "src/worker/worker-deploy-entry.ts",
    });
    expect(receiverConfig?.entry).toEqual({
      "worker/workspace-rsync-receiver": "src/worker/workspace-rsync-receiver.ts",
    });
    expect(launcherConfig?.entry).toEqual({
      "worker/github-exec-launcher": "src/agents/github-exec-launcher.ts",
    });
    const packageVersion = (
      JSON.parse(fs.readFileSync("package.json", "utf8")) as {
        version: string;
      }
    ).version;
    expect(workerConfig?.define).toEqual({
      WORKER_DEPLOY_BUILD: "true",
      WORKER_DEPLOY_VERSION: JSON.stringify(packageVersion),
    });
    expect(workerConfig?.alias).toMatchObject({
      bufferutil: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "chromium-bidi/lib/cjs/bidiMapper/BidiMapper": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "chromium-bidi/lib/cjs/cdp/CdpConnection": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "electron/index.js": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      fsevents: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      kerberos: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "utf-8-validate": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    });
    expect(workerConfig?.outDir).toBe("dist");
    expect(workerConfig?.shims).toBe(true);
    expect(workerConfig?.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "openclaw:worker-deploy" })]),
    );
    expect(workerConfig?.outputOptions).toMatchObject({
      codeSplitting: false,
      assetFileNames: "worker/[name][extname]",
    });
    for (const config of [receiverConfig, launcherConfig]) {
      expect(config?.define).toBeUndefined();
      expect(config?.alias).toBeUndefined();
      expect(config?.plugins).toBeUndefined();
      expect(config?.outputOptions).toEqual({ codeSplitting: false });
    }

    const context = {
      format: "es",
      options: {},
      pkgType: "module",
    } as Parameters<OutExtensions>[0];
    for (const config of [workerConfig, receiverConfig, launcherConfig]) {
      expect(config?.dts).toBe(false);
      expect(config?.outDir).toBe("dist");
      expect(config?.shims).toBe(true);
      expect(config?.deps?.onlyBundle).toBe(false);
      expect(config?.deps?.alwaysBundle).toBeTypeOf("function");
      const alwaysBundle = config?.deps?.alwaysBundle;
      if (typeof alwaysBundle !== "function") {
        throw new Error("worker deploy config must define dependency bundling");
      }
      expect(alwaysBundle("json5", undefined)).toBe(true);
      expect(alwaysBundle("node:fs", undefined)).toBe(false);
      expect(config?.outExtensions?.(context)).toEqual({ js: ".mjs", dts: ".d.ts" });
    }
  });

  it("keeps node package artifacts on the declared js and dts extensions", () => {
    const nodePackageConfigs = configs.filter(
      (entry) => entry.fixedExtension === false && !isWorkerBuildConfig(entry),
    );
    expect(nodePackageConfigs).not.toHaveLength(0);

    const context = {
      format: "es",
      options: {},
      pkgType: "module",
    } as Parameters<OutExtensions>[0];

    for (const entry of nodePackageConfigs) {
      expect(entry.outExtensions?.(context)).toEqual({ js: ".js", dts: ".d.ts" });
    }
  });
});

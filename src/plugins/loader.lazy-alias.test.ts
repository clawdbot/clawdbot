import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { registerSubCliByNameCore } from "../cli/program/register.subclis-core.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  createPluginCliLoadSession,
  loadPluginCliRegistrationEntriesWithDefaults,
} from "./cli-registry-loader.js";
import { registerPluginCliCommands } from "./cli.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import {
  createPluginCache,
  getPluginCache,
  resetPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";

beforeEach(() => resetPluginCache());
const roots: string[] = [];
const requireFixture = createRequire(import.meta.url);

function writeFile(root: string, name: string, content: string) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lazy-alias-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "extensions"));
  writeFile(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      type: "module",
      bin: { openclaw: "./openclaw.mjs" },
      exports: {
        "./plugin-sdk/used": "./dist/plugin-sdk/used.js",
        "./plugin-sdk/unused": "./dist/plugin-sdk/unused.js",
      },
    }),
  );
  const used = writeFile(root, "dist/plugin-sdk/used.js", 'export const value = "dist";');
  const unused = writeFile(root, "dist/plugin-sdk/unused.js", 'export const value = "unused";');
  writeFile(root, "src/plugin-sdk/used.ts", 'export const value: string = "source";');
  const entry = writeFile(
    root,
    "dist/extensions/demo/cli-metadata.cjs",
    'module.exports = { marker: "metadata", load: (name) => require(name), loadEsm: (name) => import(name) };',
  );
  return { root, entry, used, unused };
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    for (const id of Object.keys(requireFixture.cache)) {
      if (id.startsWith(`${root}${path.sep}`)) {
        delete requireFixture.cache[id];
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("native plugin alias preparation", () => {
  it("loads alias-free compiled metadata without reading unused SDK artifacts", () => {
    return withPluginCache(createPluginCache(), () => {
      const f = fixture();
      const read = vi.spyOn(fs, "readFileSync");
      const load = createPluginModuleLoader({ devSourceRoot: f.root });
      const metadata = load(f.entry);
      expect(metadata).toMatchObject({ marker: "metadata" });
      expect(load(f.entry)).toBe(metadata);
      expect(
        read.mock.calls.filter(([target]) => target === f.used || target === f.unused),
      ).toEqual([]);
    });
  });

  it("resolves late CJS and ESM aliases without reading artifacts until demanded", async () => {
    const f = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry) as {
      load: (name: string) => unknown;
      loadEsm: (name: string) => Promise<unknown>;
    };
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
    expect(metadata.load("openclaw/plugin-sdk/used")).toMatchObject({ value: "dist" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
    expect(await metadata.loadEsm("@openclaw/plugin-sdk/used.js")).toMatchObject({ value: "dist" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
    expect(await metadata.loadEsm("@openclaw/plugin-sdk/unused.js")).toMatchObject({
      value: "unused",
    });
    expect(createRequire(f.entry).resolve("openclaw/plugin-sdk/unused")).toBe(f.unused);
    expect(metadata.load("openclaw/plugin-sdk/unused")).toMatchObject({ value: "unused" });
  });

  it.each(["cjs", "mjs"])(
    "resolves the demanded alias before evaluating an alias-using %s target",
    (extension) => {
      const f = fixture();
      const entry = writeFile(
        f.root,
        `dist/extensions/demo/eager.${extension}`,
        extension === "cjs"
          ? 'module.exports = require("@openclaw/plugin-sdk/used");'
          : 'export { value } from "@openclaw/plugin-sdk/used";',
      );
      const read = vi.spyOn(fs, "readFileSync");
      const load = createPluginModuleLoader({ devSourceRoot: f.root });
      const loaded = load(entry);
      expect(loaded).toMatchObject({ value: "dist" });
      expect(load(entry)).toBe(loaded);
      expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
      expect(createRequire(entry)("@openclaw/plugin-sdk/unused")).toMatchObject({
        value: "unused",
      });
    },
  );

  it.each([
    { specifier: "@openclaw/retry", target: "dist/retry/index.js" },
    {
      specifier: "@openclaw/fixture-owner/diagnostic-api.js",
      target: "dist/extensions/fixture-owner/diagnostic-api.js",
    },
  ])("defers the full map for the $specifier alias family", ({ specifier, target: artifact }) => {
    const f = fixture();
    writeFile(f.root, artifact, 'export const value = "family";');
    writeFile(
      f.root,
      "extensions/fixture-owner/package.json",
      JSON.stringify({ name: "@openclaw/fixture-owner" }),
    );
    writeFile(
      f.root,
      "extensions/fixture-owner/diagnostic-api.ts",
      'export const value = "source";',
    );
    const entry = writeFile(
      f.root,
      "dist/extensions/demo/family.cjs",
      `module.exports = require(${JSON.stringify(specifier)});`,
    );
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    expect(load(f.entry)).toMatchObject({ marker: "metadata" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
    expect(load(entry)).toMatchObject({ value: "family" });
    expect(read.mock.calls.some(([target]) => target === f.unused)).toBe(true);
  });

  it("does not prepare aliases for unrelated requests or unregistered parents", () => {
    const f = fixture();
    const outside = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry) as { load: (name: string) => unknown };
    expect(metadata.load("node:path")).toHaveProperty("join");
    expect(() => metadata.load("@openclaw/plugin-sdk-other/used")).toThrow();
    expect(() => metadata.load("@openclaw/not-a-workspace/used")).toThrow();
    expect(() => createRequire(outside.entry).resolve("@openclaw/plugin-sdk/used")).toThrow();
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
  });

  it.each([false, true])(
    "pins a native host across ambient changes and replaces a resolved=%s provider",
    (resolveFirst) => {
      const a = fixture();
      const b = fixture();
      const entry = writeFile(
        a.root,
        "external/package.json",
        JSON.stringify({ name: "fixture-external" }),
      );
      const pluginEntry = writeFile(path.dirname(entry), "index.cjs", "module.exports = {};");
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", a.root);
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: pluginEntry });
      const requirePlugin = createRequire(pluginEntry);
      if (resolveFirst) {
        expect(requirePlugin.resolve("@openclaw/plugin-sdk/used")).toBe(a.used);
      }
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", b.root);
      vi.spyOn(process, "cwd").mockReturnValue(b.root);
      const argv = vi
        .spyOn(process, "argv", "get")
        .mockReturnValue([process.execPath, path.join(b.root, "openclaw.mjs")]);
      expect(requirePlugin.resolve("@openclaw/plugin-sdk/used")).toBe(a.used);
      // Removal is from a new host snapshot, not an in-place artifact freshness poll.
      fs.rmSync(b.unused);
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: pluginEntry });
      expect(requirePlugin.resolve("@openclaw/plugin-sdk/used")).toBe(b.used);
      expect(() => requirePlugin.resolve("@openclaw/plugin-sdk/unused")).toThrow();
      argv.mockRestore();
    },
  );

  it.each(["argv", "cwd", "module-url"])(
    "captures the %s host hint before source loading",
    (hint) => {
      const a = fixture();
      const b = fixture();
      const external = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-alias-external-")),
      );
      roots.push(external);
      const entry = writeFile(
        external,
        "index.ts",
        'import { value } from "@openclaw/plugin-sdk/used"; export const marker: string = value;',
      );
      writeFile(a.root, "src/plugin-sdk/used.ts", 'export const value = "host-a";');
      writeFile(b.root, "src/plugin-sdk/used.ts", 'export const value = "host-b";');
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", "");
      vi.stubEnv("NODE_ENV", "development");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(hint === "cwd" ? a.root : external);
      const argv = vi
        .spyOn(process, "argv", "get")
        .mockReturnValue([
          process.execPath,
          hint === "argv" ? path.join(a.root, "openclaw.mjs") : "",
        ]);
      const loader = getCachedPluginModuleLoader({
        modulePath: entry,
        tryNative: false,
        importerUrl: pathToFileURL(
          path.join(hint === "module-url" ? a.root : external, "loader.js"),
        ).href,
      });
      cwd.mockReturnValue(b.root);
      argv.mockReturnValue([process.execPath, path.join(b.root, "openclaw.mjs")]);
      expect(loader(entry)).toMatchObject({ marker: "host-a" });
    },
  );

  it("captures private QA denial before late use even if ambient authorization changes", () => {
    const f = fixture();
    writeFile(
      f.root,
      "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
      JSON.stringify(["qa-runtime"]),
    );
    writeFile(f.root, "dist/plugin-sdk/qa-runtime.js", "export const privateValue = true;");
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry) as { load: (name: string) => unknown };
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    expect(() => metadata.load("@openclaw/plugin-sdk/qa-runtime")).toThrow();
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
    expect(metadata.load("@openclaw/plugin-sdk/qa-runtime")).toMatchObject({ privateValue: true });
  });

  it("retires an unused pending provider on explicit reinstall", () => {
    const a = fixture();
    const b = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: a.entry, devSourceRoot: a.root });
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: a.entry, devSourceRoot: b.root });
    const fromPlugin = createRequire(a.entry);
    expect(fromPlugin.resolve("@openclaw/plugin-sdk/used")).toBe(b.used);
    expect(fromPlugin("@openclaw/plugin-sdk/used")).toMatchObject({ value: "dist" });
    expect(read.mock.calls.filter(([target]) => target === b.unused)).toEqual([]);
    expect(fromPlugin.resolve("@openclaw/plugin-sdk/unused")).toBe(b.unused);
    expect(fromPlugin("@openclaw/plugin-sdk/unused")).toMatchObject({ value: "unused" });
    expect(read.mock.calls.filter(([target]) => target === a.unused)).toEqual([]);
  });

  it("does not reuse a bundled private alias grant for an external plugin", () => {
    const f = fixture();
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
    writeFile(
      f.root,
      "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
      JSON.stringify(["demoted-helper"]),
    );
    writeFile(f.root, "dist/plugin-sdk/demoted-helper.js", "export const privateValue = true;");
    const external = writeFile(f.root, "external/index.cjs", "module.exports = {};");
    writeFile(f.root, "external/package.json", JSON.stringify({ name: "external-fixture" }));
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
    expect(createRequire(f.entry)("@openclaw/plugin-sdk/demoted-helper")).toMatchObject({
      privateValue: true,
    });
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: external, devSourceRoot: f.root });
    expect(() => createRequire(external).resolve("@openclaw/plugin-sdk/demoted-helper")).toThrow();
  });

  it.each([false, true])(
    "captures private owner authorization=%s before a package rename",
    (authorized) => {
      const f = fixture();
      vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
      const packageName = "@openclaw/llama-cpp-provider";
      const packageRoot = path.join(f.root, "node_modules", packageName);
      const manifest = writeFile(
        packageRoot,
        "package.json",
        JSON.stringify({ name: authorized ? packageName : "external-fixture" }),
      );
      const entry = writeFile(packageRoot, "index.cjs", "module.exports = {};");
      const target = writeFile(
        f.root,
        "dist/plugin-sdk/ssrf-runtime-internal.js",
        "export const privateValue = true;",
      );
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: entry, devSourceRoot: f.root });
      fs.writeFileSync(
        manifest,
        JSON.stringify({ name: authorized ? "external-fixture" : packageName }),
      );
      const resolve = () =>
        createRequire(entry).resolve("@openclaw/plugin-sdk/ssrf-runtime-internal");
      if (authorized) {
        expect(resolve()).toBe(target);
      } else {
        expect(resolve).toThrow();
      }
    },
  );

  it.each([false, true])(
    "captures source preference before transformer use, stale dist=%s",
    (staleDist) => {
      const a = fixture();
      const b = fixture();
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", a.root);
      vi.stubEnv("NODE_ENV", staleDist ? "production" : "development");
      if (staleDist) {
        fs.writeFileSync(a.used, 'export { value } from "./missing.js";');
      }
      const entry = writeFile(
        a.root,
        "extensions/demo/transform.ts",
        'import { value } from "@openclaw/plugin-sdk/used"; export const marker: string = value;',
      );
      const read = vi.spyOn(fs, "readFileSync");
      const loader = getCachedPluginModuleLoader({
        modulePath: entry,
        importerUrl: import.meta.url,
        tryNative: false,
      });
      expect(read.mock.calls.filter(([target]) => target === a.unused)).toEqual([]);
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", b.root);
      vi.stubEnv("NODE_ENV", "production");
      expect(loader(entry)).toMatchObject({ marker: "source" });
      expect(
        read.mock.calls.filter(([target]) => target === b.used || target === b.unused),
      ).toEqual([]);
      expect(loader(entry)).toBe(loader(entry));
    },
  );

  it.each([
    "explicit",
    "standalone",
    "deferred",
    "nodes",
    "pairing-before",
    "plugins-after",
  ] as const)("keeps late Commander action aliases for %s registration", async (registration) => {
    const f = fixture();
    const pluginDir = path.dirname(f.entry);
    // Use the supported entrypoint metadata fallback, including nested CLI descriptors.
    fs.unlinkSync(f.entry);
    const observed = path.join(f.root, "action.json");
    const entry = writeFile(
      pluginDir,
      "index.cjs",
      `module.exports = { id: "demo", register(api) {
      api.registerCli(({ program }) => program.command("late").action(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => require("openclaw/plugin-sdk/used")),
          import("@openclaw/plugin-sdk/unused.js"),
        ]);
        require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify(results.map(result =>
          result.status === "fulfilled" ? result.value.value : { error: result.reason.code, message: result.reason.message }
        )));
      }), { commands: ["late"], descriptors: [{ name: "late", description: "Late import", hasSubcommands: false }], parentPath: ${JSON.stringify(registration === "nodes" ? ["nodes"] : [])} });
    } };`,
    );
    writeFile(
      pluginDir,
      "package.json",
      JSON.stringify({ name: "demo", openclaw: { extensions: ["./index.cjs"] } }),
    );
    writeFile(
      pluginDir,
      "openclaw.plugin.json",
      JSON.stringify({
        id: "demo",
        configSchema: { type: "object", properties: {} },
        ...(registration === "nodes"
          ? {}
          : { cliCommands: [{ name: "late", description: "Late import", hasSubcommands: false }] }),
      }),
    );
    const cfg = {
      plugins: {
        allow: ["demo"],
        load: { paths: [entry] },
        entries: { demo: { enabled: true } },
      },
    };
    const env = {
      HOME: f.root,
      OPENCLAW_STATE_DIR: path.join(f.root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(f.root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DEV_SOURCE_ROOT: f.root,
    };
    const program = new Command().exitOverride();
    const parse = () =>
      program.parseAsync(registration === "nodes" ? ["nodes", "late"] : ["late"], {
        from: "user",
      });
    if (registration === "explicit") {
      const session = createPluginCliLoadSession();
      const [registrar] = await loadPluginCliRegistrationEntriesWithDefaults({
        session,
        cfg,
        env,
        primaryCommand: "late",
      });
      await withPluginCache(createPluginCache(), () => registrar!.register(program));
      session.close();
      await expect(registrar!.register(new Command())).rejects.toThrow(/preparation is closed/);
      await withPluginCache(createPluginCache(), () => session.withCache(parse));
    } else if (registration === "standalone" || registration === "deferred") {
      await registerPluginCliCommands(program, cfg, env, undefined, {
        mode: registration === "deferred" ? "lazy" : "eager",
      });
      await parse();
    } else {
      clearRuntimeConfigSnapshot();
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
      const name =
        registration === "nodes"
          ? "nodes"
          : registration === "pairing-before"
            ? "pairing"
            : "plugins";
      // Eager traversal forwards the active invocation to every core registrar. Memory's
      // plugin-loading policy exercises both before/after branches without changing policy.
      const argv =
        registration === "nodes"
          ? ["node", "openclaw", "nodes", "late"]
          : ["node", "openclaw", "memory", "status"];
      await registerSubCliByNameCore(program, name, argv);
      if (registration !== "nodes") {
        const names = program.commands.map((command) => command.name());
        expect(names.indexOf("late") < names.indexOf(name)).toBe(registration === "pairing-before");
      }
      await parse();
    }
    expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual(["dist", "unused"]);
  });

  it("keeps deferred aliases in their owner and acquires changed facts only in a new operation", () => {
    const f = fixture();
    const owner = createPluginCache();
    const params = { modulePath: f.entry, importerUrl: import.meta.url, devSourceRoot: f.root };
    const retained = withPluginCache(owner, () => getCachedPluginModuleLoader(params));
    const other = createPluginCache();
    const metadata = withPluginCache(other, () => retained(f.entry));
    expect(withPluginCache(owner, () => getCachedPluginModuleLoader(params)(f.entry))).toBe(
      metadata,
    );
    expect(other.sources.size).toBe(0);
    withPluginCache(owner, () =>
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root }),
    );
    withPluginCache(owner, () =>
      expect(createRequire(f.entry).resolve("openclaw/plugin-sdk/unused")).toBe(f.unused),
    );
    fs.unlinkSync(f.unused);
    resetPluginCache();
    withPluginCache(owner, () =>
      expect(createRequire(f.entry).resolve("openclaw/plugin-sdk/unused")).toBe(f.unused),
    );
    withPluginCache(createPluginCache(), () => {
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
      expect(() => createRequire(f.entry).resolve("@openclaw/plugin-sdk/unused")).toThrow();
    });
  });

  it.each([undefined, "shared", ""])(
    "preserves explicit alias contents and shared scope %s",
    (sharedCacheScopeKey) => {
      const f = fixture();
      const owner = createPluginCache();
      const target = writeFile(
        f.root,
        "target.ts",
        'import { value } from "fixture-alias"; export const marker = value;',
      );
      const params = {
        modulePath: target,
        importerUrl: import.meta.url,
        tryNative: false,
        sharedCacheScopeKey,
      };
      withPluginCache(owner, () => {
        const aliases = { "fixture-alias": f.used };
        const first = getCachedPluginModuleLoader({ ...params, aliasMap: aliases });
        const same = getCachedPluginModuleLoader({ ...params, aliasMap: { ...aliases } });
        expect(same).toBe(first);
        aliases["fixture-alias"] = f.unused;
        expect(first(target)).toMatchObject({ marker: "dist" });
        const next = getCachedPluginModuleLoader({ ...params, aliasMap: aliases });
        expect(next === first).toBe(sharedCacheScopeKey !== undefined);
        expect(getPluginCache().sdk.contexts.size).toBe(0);
      });
    },
  );
});

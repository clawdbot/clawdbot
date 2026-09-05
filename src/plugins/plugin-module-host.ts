import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createJiti, type Jiti } from "jiti";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../infra/path-guards.js";
import { isPluginSdkAliasSpecifier } from "./sdk-alias.js";

type ModuleRecord = {
  id: string;
  filename: string;
  path: string;
  exports: unknown;
  loaded: boolean;
  parent?: ModuleRecord;
  children: ModuleRecord[];
  require: ((specifier: string) => unknown) & { resolve: (specifier: string) => string };
  pending?: Promise<unknown>;
};

/** Owns an immutable plugin module graph. This realm is a lifecycle boundary, not a sandbox. */
export function createPluginModuleHost(options: {
  pluginId: string;
  rootDir: string;
  loadHostModule: (specifier: string) => unknown;
  loadNativeModule?: (filename: string) => unknown;
  globals?: Record<string, unknown>;
}) {
  const root = fs.realpathSync(options.rootDir);
  const modules: Record<string, ModuleRecord> = Object.create(null);
  const resolvers = new Map<string, Jiti>();
  const resolutions = new Map<string, string>();
  const canonicalPaths = new Map<string, string>();
  const hostModules = new Map<string, unknown>();
  let context: vm.Context | undefined = vm.createContext(
    {
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      DOMException,
      Event,
      EventTarget,
      Blob,
      File,
      FormData,
      Headers,
      Request,
      Response,
      ReadableStream,
      WritableStream,
      TransformStream,
      fetch,
      structuredClone,
      atob,
      btoa,
      crypto,
      performance,
      queueMicrotask,
      console,
      // The instance owner supplies process events and timers with resource ownership.
      process: {
        env: process.env,
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        versions: process.versions,
        cwd: () => process.cwd(),
      },
      ...options.globals,
    },
    { name: `plugin:${options.pluginId}` },
  );
  context.global = context;
  const assertActive = () => {
    if (!context) {
      throw new Error(`Plugin ${options.pluginId} module host is disposed`);
    }
  };
  const unsupported = (detail: string): never => {
    throw new Error(
      `Plugin ${options.pluginId} cannot use ${detail} in its managed module host. Run that component in a separate process.`,
    );
  };
  const getResolver = (filename: string) => {
    let resolver = resolvers.get(filename);
    if (!resolver) {
      // Only resolution and transformation are used: Jiti evaluation can fall back
      // to native ESM, whose process-wide module map cannot retire a generation.
      resolver = createJiti(filename, { fsCache: false, moduleCache: false, tryNative: false });
      resolvers.set(filename, resolver);
    }
    return resolver;
  };
  const isHostModule = (specifier: string) =>
    isBuiltin(specifier) ||
    specifier === "openclaw/plugin-sdk" ||
    isPluginSdkAliasSpecifier(specifier);
  const resolve = (specifier: string, filename: string, async: boolean): string => {
    assertActive();
    if (isHostModule(specifier)) {
      return isBuiltin(specifier) ? `node:${specifier.replace(/^node:/, "")}` : specifier;
    }
    const key = `${filename}\0${async}\0${specifier}`;
    const cached = resolutions.get(key);
    if (cached) {
      return cached;
    }
    const resolver = getResolver(filename);
    // Source imports conventionally spell .js. A co-located stale build must
    // not win when the importing module itself is TypeScript.
    if (/\.[cm]?tsx?$/.test(filename) && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const source = resolver.esmResolve(specifier.replace(/\.js$/, ".ts"), { try: true });
      if (source) {
        const resolved = source.startsWith("file:") ? fileURLToPath(source) : source;
        resolutions.set(key, resolved);
        return resolved;
      }
    }
    const resolved = async ? resolver.esmResolve(specifier) : resolver.resolve(specifier);
    const result = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    resolutions.set(key, result);
    return result;
  };
  const hostModule = (specifier: string): unknown => {
    if (hostModules.has(specifier)) {
      return hostModules.get(specifier);
    }
    let loaded = options.loadHostModule(specifier);
    if (specifier === "node:process") {
      // SAFETY: The host resolver returns Node's process object for this builtin specifier.
      loaded = new Proxy(loaded as object, {
        get(target, key, receiver) {
          if (key === "getBuiltinModule") {
            return (name: string) =>
              isBuiltin(name) ? hostModule(`node:${name.replace(/^node:/, "")}`) : undefined;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }
    if (specifier === "node:module") {
      // SAFETY: The host resolver returns Node's module namespace for this builtin specifier.
      const native = loaded as object;
      const managed = new Proxy(native, {
        get(target, key, receiver) {
          if (key === "createRequire") {
            return (filename: string | URL) =>
              createRequire(
                filename instanceof URL || filename.startsWith("file:")
                  ? fileURLToPath(filename)
                  : filename,
              );
          }
          if (key === "Module") {
            return managed;
          }
          if (
            ["_load", "_extensions", "register", "registerHooks", "runMain"].includes(String(key))
          ) {
            return () => unsupported(`the custom native module loader ${String(key)}`);
          }
          return Reflect.get(target, key, receiver);
        },
        apply: () => unsupported("a custom native Module"),
        construct: () => unsupported("a custom native Module"),
      });
      loaded = managed;
    }
    hostModules.set(specifier, loaded);
    return loaded;
  };
  const createRequire = (filename: string, ancestry = new Set<string>()) => {
    const require = (specifier: string): unknown =>
      load(resolve(specifier, filename, false), false, ancestry, modules[filename]);
    return Object.assign(require, {
      resolve: Object.assign((specifier: string) => resolve(specifier, filename, false), {
        paths: (specifier: string) => getResolver(filename).resolve.paths(specifier),
      }),
      cache: modules,
      extensions: Object.freeze({}),
      main: undefined,
    });
  };
  const load = (
    target: string,
    async: boolean,
    ancestry: Set<string>,
    parent?: ModuleRecord,
  ): unknown => {
    assertActive();
    if (isHostModule(target)) {
      return hostModule(target);
    }
    const filename = canonicalPaths.get(target) ?? fs.realpathSync(target);
    canonicalPaths.set(target, filename);
    if (!isPathInside(root, filename)) {
      throw new Error(
        `Plugin ${options.pluginId} import leaves its captured module graph: ${target}. Declare the package dependency and reload.`,
      );
    }
    if (path.extname(filename) === ".node") {
      return options.loadNativeModule
        ? options.loadNativeModule(filename)
        : unsupported(`native addon ${path.basename(filename)} without a dependency owner`);
    }
    const cached = modules[filename];
    if (cached) {
      if (!async && cached.pending && !cached.loaded && !ancestry.has(filename)) {
        throw new Error(
          `Plugin ${options.pluginId} must await import() of the asynchronous module ${filename}`,
        );
      }
      return async && !ancestry.has(filename) ? (cached.pending ?? cached.exports) : cached.exports;
    }
    const opened = openRootFileSync({
      absolutePath: filename,
      rootPath: root,
      boundaryLabel: "plugin generation",
      rejectHardlinks: true,
    });
    if (!opened.ok) {
      throw new Error(`Cannot read plugin module ${filename}`, { cause: opened.error });
    }
    let source: string;
    try {
      source = fs.readFileSync(opened.fd, "utf8");
    } finally {
      fs.closeSync(opened.fd);
    }
    const chain = new Set(ancestry).add(filename);
    const require = createRequire(filename, chain);
    const module: ModuleRecord = {
      id: filename,
      filename,
      path: path.dirname(filename),
      exports: {},
      loaded: false,
      parent,
      children: [],
      require,
    };
    modules[filename] = module;
    parent?.children.push(module);
    const discard = (error: unknown): never => {
      delete modules[filename];
      if (parent) {
        parent.children = parent.children.filter((child) => child !== module);
      }
      throw error;
    };
    const finish = () => {
      assertActive();
      const moduleExports = asOptionalRecord(module.exports);
      // SAFETY: Jiti's Babel transform emits this parse-error payload instead of executable code.
      const failure = moduleExports?.["__JITI_ERROR__"] as
        | { message: string; line: number; column: number }
        | undefined;
      if (failure) {
        throw new SyntaxError(`${failure.message} (${filename}:${failure.line}:${failure.column})`);
      }
      module.loaded = true;
      return module.exports;
    };
    try {
      if (path.extname(filename) === ".json") {
        module.exports = JSON.parse(source);
      } else {
        const code = getResolver(filename).transform({
          source,
          filename,
          ts: /\.[cm]?tsx?$/.test(filename),
          async,
          interopDefault: true,
          babel: {
            plugins: [
              {
                visitor: {
                  "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"({
                    node,
                  }: {
                    node: { source?: { value: string } | null };
                  }) {
                    // Synchronous registration still uses ESM export conditions for
                    // static imports; Jiti otherwise rewrites them to CommonJS require.
                    if (node.source) {
                      node.source.value = resolve(node.source.value, filename, true);
                    }
                  },
                },
              },
            ],
          },
        });
        const evaluate = new vm.Script(
          `(${async ? "async " : ""}function(exports,require,module,__filename,__dirname,jitiImport,jitiESMResolve){${code}\n})`,
          { filename },
        ).runInContext(context!);
        const result = evaluate.call(
          module.exports,
          module.exports,
          require,
          module,
          filename,
          module.path,
          async (specifier: string) =>
            await load(resolve(specifier, filename, true), true, chain, module),
          (specifier: string) => {
            const resolved = resolve(specifier, filename, true);
            return isHostModule(resolved) ? resolved : pathToFileURL(resolved).href;
          },
        );
        if (async) {
          module.pending = Promise.resolve(result).then(finish).catch(discard);
          return module.pending;
        }
      }
      return finish();
    } catch (error) {
      return discard(error);
    }
  };
  // Node's alternate builtin lookup must share the same managed module loader
  // as imports, including createRequire and resource-owning builtin facades.
  if (options.globals?.process) {
    context.process = hostModule("node:process");
  }
  return {
    load: (entry: string): unknown =>
      load(
        resolve(path.resolve(root, entry), path.join(root, "entry.js"), false),
        false,
        new Set(),
      ),
    dispose: () => {
      context = undefined;
      for (const key of Object.keys(modules)) {
        delete modules[key];
      }
      resolvers.clear();
      resolutions.clear();
      canonicalPaths.clear();
      hostModules.clear();
    },
  };
}

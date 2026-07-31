import { toSafeImportPath } from "../shared/import-specifier.js";
import { attachPluginApiFacades } from "./api-facades.js";
import { isLateCallablePluginApiMethod } from "./api-lifecycle.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { withProfile } from "./plugin-load-profile.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";
import type { CreatePluginRuntimeOptions, PluginRuntime } from "./runtime/types.js";
import {
  buildPluginLoaderAliasMap,
  type PluginRuntimeModuleResolution,
  type PluginSdkResolutionPreference,
  resolvePluginRuntimeModulePathWithDiagnostics,
} from "./sdk-alias.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "./types.js";

const LAZY_RUNTIME_REFLECTION_KEYS = [
  "version",
  "gateway",
  "config",
  "agent",
  "subagent",
  "system",
  "media",
  "mediaUnderstanding",
  "tts",
  "channel",
  "events",
  "logging",
  "state",
  "modelAuth",
  "imageGeneration",
  "videoGeneration",
  "musicGeneration",
  "llm",
] as const satisfies readonly (keyof PluginRuntime)[];

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function createGuardedPluginRegistrationApi(api: OpenClawPluginApi): {
  api: OpenClawPluginApi;
  close: () => void;
} {
  let closed = false;
  const guardedApi = attachPluginApiFacades(
    new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        if (typeof prop === "string" && isLateCallablePluginApiMethod(prop)) {
          return (...args: unknown[]) => Reflect.apply(value, target, args);
        }
        return (...args: unknown[]) => {
          if (closed) {
            return undefined;
          }
          return Reflect.apply(value, target, args);
        };
      },
    }),
  );
  return {
    api: guardedApi,
    close: () => {
      closed = true;
    },
  };
}

export function runPluginRegisterSync(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
): void {
  const guarded = createGuardedPluginRegistrationApi(api);
  try {
    const result = register(guarded.api);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("plugin register must be synchronous");
    }
  } finally {
    guarded.close();
  }
}

export function createPluginModuleLoader(options: {
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();
  const createLoaderForModule = (modulePath: string) => {
    installOpenClawPluginSdkNativeResolver({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      pluginModulePath: modulePath,
      devSourceRoot: options.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
    });
    return getCachedPluginModuleLoader({
      cache: moduleLoaders,
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: modulePath,
      devSourceRoot: options.devSourceRoot,
      aliasMap: buildPluginLoaderAliasMap(
        modulePath,
        process.argv[1],
        import.meta.url,
        options.pluginSdkResolution,
        options.devSourceRoot,
      ),
      pluginSdkResolution: options.pluginSdkResolution,
    });
  };
  return (modulePath: string): unknown =>
    createLoaderForModule(modulePath)(toSafeImportPath(modulePath));
}

function formatPluginRuntimeModuleResolutionError(params: {
  resolution: PluginRuntimeModuleResolution;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string {
  const { resolution } = params;
  const candidates = resolution.candidates.length > 0 ? resolution.candidates.join(", ") : "<none>";
  return [
    "Unable to resolve plugin runtime module",
    `loader=${resolution.modulePath ?? "<unresolved>"}`,
    `packageRoot=${resolution.packageRoot ?? "<none>"}`,
    `pluginSdkResolution=${params.pluginSdkResolution ?? "auto"}`,
    `candidates=${candidates}`,
    ...(resolution.error ? [`resolverError=${resolution.error}`] : []),
  ].join("; ");
}

/** Lazily materializes the broad plugin runtime only when registration reads it. */
export function createLazyPluginRuntime(params: {
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  runtimeOptions?: CreatePluginRuntimeOptions;
  loadPluginModule: ReturnType<typeof createPluginModuleLoader>;
}): PluginRuntime {
  // Avoid loading every channel/runtime dependency tree until a plugin actually
  // reaches a runtime API surface.
  let createPluginRuntimeFactory: ((options?: CreatePluginRuntimeOptions) => PluginRuntime) | null =
    null;
  const resolveCreatePluginRuntime = (): ((
    options?: CreatePluginRuntimeOptions,
  ) => PluginRuntime) => {
    if (createPluginRuntimeFactory) {
      return createPluginRuntimeFactory;
    }
    const resolution = resolvePluginRuntimeModulePathWithDiagnostics({
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    if (!resolution.resolvedPath) {
      throw new Error(
        formatPluginRuntimeModuleResolutionError({
          resolution,
          pluginSdkResolution: params.pluginSdkResolution,
        }),
      );
    }
    const resolvedPath = resolution.resolvedPath;
    const runtimeModule = withProfile(
      { source: resolvedPath },
      "runtime-module",
      () =>
        params.loadPluginModule(resolvedPath) as {
          createPluginRuntime?: (options?: CreatePluginRuntimeOptions) => PluginRuntime;
        },
    );
    if (typeof runtimeModule.createPluginRuntime !== "function") {
      throw new Error("Plugin runtime module missing createPluginRuntime export");
    }
    createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
    return createPluginRuntimeFactory;
  };

  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= resolveCreatePluginRuntime()(params.runtimeOptions);
    return resolvedRuntime;
  };
  const lazyRuntimeReflectionKeySet = new Set<PropertyKey>(LAZY_RUNTIME_REFLECTION_KEYS);
  const resolveLazyRuntimeDescriptor = (prop: PropertyKey): PropertyDescriptor | undefined => {
    if (!lazyRuntimeReflectionKeySet.has(prop)) {
      return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
    }
    return {
      configurable: true,
      enumerable: true,
      get() {
        return Reflect.get(resolveRuntime() as object, prop);
      },
      set(value: unknown) {
        Reflect.set(resolveRuntime() as object, prop, value);
      },
    };
  };
  return new Proxy({} as PluginRuntime, {
    get(_target, prop, receiver) {
      return Reflect.get(resolveRuntime(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(resolveRuntime(), prop, value, receiver);
    },
    has(_target, prop) {
      return lazyRuntimeReflectionKeySet.has(prop) || Reflect.has(resolveRuntime(), prop);
    },
    ownKeys() {
      return [...LAZY_RUNTIME_REFLECTION_KEYS];
    },
    getOwnPropertyDescriptor(_target, prop) {
      return resolveLazyRuntimeDescriptor(prop);
    },
    defineProperty(_target, prop, attributes) {
      return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(resolveRuntime() as object, prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveRuntime() as object);
    },
  });
}

export function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const seen = new Set<unknown>();
  const candidates: unknown[] = [unwrapDefaultModuleExport(moduleExport), moduleExport];
  for (let index = 0; index < candidates.length && index < 12; index += 1) {
    const resolved = candidates[index];
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (typeof resolved === "function") {
      return { register: resolved as OpenClawPluginDefinition["register"] };
    }
    if (resolved && typeof resolved === "object") {
      const definition = resolved as OpenClawPluginDefinition;
      const register = definition.register;
      if (typeof register === "function") {
        return { definition, register };
      }
      for (const key of ["default", "module"]) {
        if (key in definition) {
          candidates.push((definition as Record<string, unknown>)[key]);
        }
      }
    }
  }
  const resolved = candidates[0];
  if (typeof resolved === "function") {
    return { register: resolved as OpenClawPluginDefinition["register"] };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return { definition, register: definition.register };
  }
  return {};
}

function kindIncludes(kind: unknown, target: string): boolean {
  return kind === target || (Array.isArray(kind) && kind.includes(target));
}

export function formatBundledChannelWrongLoaderError(kind: unknown): string | null {
  if (kindIncludes(kind, "bundled-channel-setup-entry")) {
    return "bundled channel setup entry requires setup-runtime loader";
  }
  if (kindIncludes(kind, "bundled-channel-entry")) {
    return "bundled channel entry requires setup-runtime loader";
  }
  return null;
}

export type PluginModuleLoader = ReturnType<typeof createPluginModuleLoader>;

import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { VERSION } from "../version.js";
import { attachPluginApiFacades } from "./api-facades.js";
import { isLateCallablePluginApiMethod } from "./api-lifecycle.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { getPluginCache, withPluginCache } from "./plugin-cache.js";
import { withProfile } from "./plugin-load-profile.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRegistrationContext } from "./runtime.js";
import { createRuntimeBase } from "./runtime/runtime-base.js";
import type {
  CreatePluginRuntimeOptions,
  PluginRuntimeFactory,
  PluginRuntime,
} from "./runtime/types.js";
import {
  type PluginRuntimeModuleResolution,
  type PluginSdkResolutionPreference,
  resolvePluginRuntimeModulePathWithDiagnostics,
} from "./sdk-alias.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "./types.js";

// Preserve the existing enumeration order, appending surfaces added to the runtime contract.
// Scoped runtime proxies also ask for descriptors after their get trap returns.
const LAZY_RUNTIME_PROPERTIES = {
  version: true,
  gateway: true,
  config: true,
  agent: true,
  subagent: true,
  system: true,
  media: true,
  mediaUnderstanding: true,
  tts: true,
  channel: true,
  events: true,
  logging: true,
  state: true,
  modelAuth: true,
  imageGeneration: true,
  videoGeneration: true,
  musicGeneration: true,
  llm: true,
  hooks: true,
  nodes: true,
  sandbox: true,
  worktrees: true,
  webSearch: true,
  tasks: true,
  modelConfig: true,
} satisfies Record<keyof PluginRuntime, true>;

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

function runPluginRegisterSync(
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

export function runPluginRegisterSyncInRegistry(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
  registry: PluginRegistry,
  pluginId: string,
): void {
  withPluginRegistrationContext(registry, pluginId, () => runPluginRegisterSync(register, api), {
    registerMemoryCapability: api.registerMemoryCapability,
  });
}

export function createPluginModuleLoader(options: {
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  tryNative?: boolean;
  loaderFilename?: string;
  installNativeSdkResolver?: boolean;
}) {
  const cache = getPluginCache();
  const captured = { ...options };
  const createLoaderForModule = (modulePath: string) => {
    if (captured.installNativeSdkResolver !== false && captured.tryNative !== false) {
      installOpenClawPluginSdkNativeResolver({
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
        pluginModulePath: modulePath,
        devSourceRoot: captured.devSourceRoot,
        pluginSdkResolution: captured.pluginSdkResolution,
      });
    }
    return getCachedPluginModuleLoader({
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: captured.loaderFilename ?? modulePath,
      devSourceRoot: captured.devSourceRoot,
      pluginSdkResolution: captured.pluginSdkResolution,
      ...(captured.tryNative !== undefined ? { tryNative: captured.tryNative } : {}),
    });
  };
  return (modulePath: string): unknown =>
    withPluginCache(cache, () => createLoaderForModule(modulePath)(toSafeImportPath(modulePath)));
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
  const cache = getPluginCache();
  type RuntimeModule = {
    createPluginRuntime?: PluginRuntimeFactory;
  };
  let runtimeModule: RuntimeModule | undefined;
  const resolveRuntimeModule = (): RuntimeModule => {
    if (runtimeModule) {
      return runtimeModule;
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
    runtimeModule = withPluginCache(cache, () =>
      withProfile(
        { source: resolvedPath },
        "runtime-module",
        () => params.loadPluginModule(resolvedPath) as RuntimeModule,
      ),
    );
    return runtimeModule;
  };

  const base = createRuntimeBase();
  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= withPluginCache(cache, () => {
      const { createPluginRuntime } = resolveRuntimeModule();
      if (typeof createPluginRuntime !== "function") {
        throw new Error("Plugin runtime module missing createPluginRuntime export");
      }
      return createPluginRuntime(params.runtimeOptions, base);
    });
    return resolvedRuntime;
  };
  const getRuntimeProperty = (prop: PropertyKey, ...receiver: [] | [unknown]): unknown => {
    // Prepared metadata and host facades must not initialize broad runtime services.
    if (!resolvedRuntime) {
      if (
        prop === "gateway" ||
        prop === "hooks" ||
        prop === "nodes" ||
        prop === "subagent" ||
        prop === "modelAuth" ||
        prop === "modelConfig"
      ) {
        const value = params.runtimeOptions?.[prop];
        if (value !== undefined) {
          return value;
        }
      }
      if (prop === "version") {
        return VERSION;
      }
      if (prop === "config" || prop === "state" || prop === "system") {
        return base[prop];
      }
    }
    return receiver.length === 0
      ? Reflect.get(resolveRuntime(), prop)
      : Reflect.get(resolveRuntime(), prop, receiver[0]);
  };
  const resolveLazyRuntimeDescriptor = (prop: PropertyKey): PropertyDescriptor | undefined => {
    // Once loaded, assignment through the proxy must see the owner's real descriptor.
    if (resolvedRuntime || !Object.hasOwn(LAZY_RUNTIME_PROPERTIES, prop)) {
      return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
    }
    const descriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      get() {
        return getRuntimeProperty(prop);
      },
    };
    // Policy facets match defineCachedValue's getter-only contract before loading too.
    if (prop !== "modelAuth" && prop !== "modelConfig") {
      descriptor.set = (value: unknown) => {
        Reflect.set(resolveRuntime() as object, prop, value);
      };
    }
    return descriptor;
  };
  return new Proxy({} as PluginRuntime, {
    get: (_target, prop, receiver) => getRuntimeProperty(prop, receiver),
    set(_target, prop, value, receiver) {
      return Reflect.set(resolveRuntime(), prop, value, receiver);
    },
    has(_target, prop) {
      return Object.hasOwn(LAZY_RUNTIME_PROPERTIES, prop) || Reflect.has(resolveRuntime(), prop);
    },
    ownKeys() {
      return Object.keys(LAZY_RUNTIME_PROPERTIES);
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

import { toSafeImportPath } from "../shared/import-specifier.js";
import { VERSION } from "../version.js";
import { runPluginRegistration } from "./api-lifecycle.js";
import { getPluginCache, withPluginCache } from "./plugin-cache.js";
import { getPluginInstance, getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { withProfile } from "./plugin-load-profile.js";
import {
  bindPluginInstanceModuleLoader,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
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
import type { OpenClawPluginDefinition } from "./types.js";

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
} satisfies Record<keyof PluginRuntime, true>;

export function runPluginRegisterSyncInRegistry(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
  registry: PluginRegistry,
  pluginId: string,
): void {
  const run = () =>
    withPluginRegistrationContext(registry, pluginId, () => runPluginRegistration(register, api), {
      registerMemoryCapability: api.registerMemoryCapability,
    });
  const owner = getPluginValueInstance(api);
  if (owner) {
    owner.run(run);
    owner.toolRegistrationComplete ||=
      api.registrationMode === "full" || api.registrationMode === "tool-discovery";
  } else {
    run();
  }
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
  return (
    modulePath: string,
    owner?: {
      record: PluginRecord;
      rootDir: string;
      registry: PluginRegistry;
      standalone?: boolean;
    },
  ): unknown =>
    withPluginCache(cache, () => {
      if (!owner) {
        return createLoaderForModule(modulePath)(toSafeImportPath(modulePath));
      }
      let instance = getPluginInstance(owner.record);
      if (!instance) {
        instance = new PluginInstance(owner.record.id, owner);
        const loadHostModule = createLoaderForModule(modulePath);
        bindPluginInstanceModuleLoader({
          instance,
          source: modulePath,
          rootDir: owner.rootDir,
          origin: owner.record.origin,
          standalone: owner.standalone,
          loadHostModule: (source) => loadHostModule(toSafeImportPath(source)),
        });
      }
      return instance.loadModule(modulePath);
    });
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
  let createPluginRuntimeFactory: PluginRuntimeFactory | null = null;
  const resolveCreatePluginRuntime = (): PluginRuntimeFactory => {
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
          createPluginRuntime?: PluginRuntimeFactory;
        },
    );
    if (typeof runtimeModule.createPluginRuntime !== "function") {
      throw new Error("Plugin runtime module missing createPluginRuntime export");
    }
    createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
    return createPluginRuntimeFactory;
  };

  const cache = getPluginCache();
  const base = createRuntimeBase();
  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= withPluginCache(cache, () =>
      resolveCreatePluginRuntime()(params.runtimeOptions, base),
    );
    return resolvedRuntime;
  };
  const getRuntimeProperty = (prop: PropertyKey, ...receiver: [] | [unknown]): unknown => {
    // Prepared metadata and host facades must not initialize broad runtime services.
    if (!resolvedRuntime) {
      if (prop === "gateway" || prop === "nodes" || prop === "subagent") {
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
    return {
      configurable: true,
      enumerable: true,
      get() {
        return getRuntimeProperty(prop);
      },
      set(value: unknown) {
        Reflect.set(resolveRuntime() as object, prop, value);
      },
    };
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

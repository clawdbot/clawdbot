/** Loads plugin CLI registrations lazily for the command tree and plugin-owned subcommands. */
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { collectUniqueCommandDescriptors } from "../cli/program/command-descriptor-utils.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import { createPluginCliGatewayNodesRuntime } from "./cli-gateway-nodes-runtime.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadOpenClawPluginCliRegistry, loadPluginRegistryHandle } from "./loader.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  resolvePluginMetadataEnvFingerprint,
  resolvePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import type {
  OpenClawPluginCliContext,
  OpenClawPluginCliRootCommandDescriptor,
  PluginLogger,
} from "./types.js";

export type PluginCliLoaderOptions = Pick<PluginLoadOptions, "pluginSdkResolution">;

/** Public CLI loader options passed from command bootstrap surfaces. */
export type PluginCliPublicLoadParams = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loaderOptions?: PluginCliLoaderOptions;
  logger?: PluginLogger;
  primaryCommand?: string;
  session?: PluginCliLoadSession;
};

export type PluginCliCommandGroupEntry = {
  pluginId: string;
  parentPath: readonly string[];
  placeholders: readonly OpenClawPluginCliRootCommandDescriptor[];
  names: readonly string[];
  register: (program: OpenClawPluginCliContext["program"]) => Promise<void>;
};

const log = createSubsystemLogger("plugins/cli-registry-loader");

type PreparedPluginCliLoad = {
  context: PluginRuntimeLoadContext;
  assertCurrent: () => void;
  withCache: <T>(run: () => T) => T;
  metadataRegistry?: Promise<PluginRegistry>;
  entries?: Promise<PluginCliCommandGroupEntry[]>;
};

export type PluginCliLoadSession = ReturnType<typeof createPluginCliLoadSession>;

/** Invocation authority closes before actions; its package generation lives through them. */
export function createPluginCliLoadSession(cache = createPluginCache()) {
  const withCache = <T>(run: () => T): T => withPluginCache(cache, run);
  let closed = false;
  let revision = getCurrentPluginMetadataSnapshotState().revision;
  let current:
    | {
        key: string;
        logger?: PluginLogger;
        env: NodeJS.ProcessEnv;
        sdk?: PluginCliLoaderOptions["pluginSdkResolution"];
        prepared: PreparedPluginCliLoad;
      }
    | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Plugin CLI preparation is closed; start a new registration operation.");
    }
  };
  const refreshRevision = () => {
    assertOpen();
    const next = getCurrentPluginMetadataSnapshotState().revision;
    if (next !== revision) {
      revision = next;
      current = undefined;
    }
  };
  const assertRevision = (captured: symbol) => {
    assertOpen();
    if (captured !== getCurrentPluginMetadataSnapshotState().revision) {
      throw new Error(
        "Plugin CLI preparation was invalidated; start a new registration operation.",
      );
    }
  };
  return {
    withCache,
    readConfig: async <T>(read: () => Promise<T>): Promise<T> => {
      refreshRevision();
      const captured = revision;
      const result = await withCache(read);
      assertRevision(captured);
      return result;
    },
    close: () => {
      closed = true;
      current = undefined;
    },
    resolve: (params: PluginCliPublicLoadParams): PreparedPluginCliLoad =>
      withCache(() => {
        refreshRevision();
        const config = params.cfg ?? getRuntimeConfig();
        const activationSourceConfig = resolvePluginActivationSourceConfig({ config });
        const env = params.env ?? process.env;
        const inputKey = () =>
          stableStringify([
            config,
            resolvePluginActivationSourceConfig({ config }),
            env,
            resolvePluginControlPlaneWorkspace({ config, env }),
            resolvePluginMetadataEnvFingerprint(env),
            resolveStateDir(env),
            params.primaryCommand,
          ]);
        const key = inputKey();
        const sdk = params.loaderOptions?.pluginSdkResolution;
        // Equal values permit package reuse, but raw/source identities retain private provenance.
        if (
          current?.key === key &&
          current.logger === params.logger &&
          current.env === env &&
          current.sdk === sdk &&
          current.prepared.context.rawConfig === config &&
          current.prepared.context.activationSourceConfig === activationSourceConfig
        ) {
          return current.prepared;
        }
        const preparedEnv = cloneEnvWithPlatformSemantics(env);
        const { workspaceDir } = resolvePluginControlPlaneWorkspace({ config, env: preparedEnv });
        // An omitted execution owner means shared roots, not the validation union. Supplying
        // this original snapshot also keeps runtime/load-context's Gateway default unchanged.
        const metadataSnapshot = resolvePluginMetadataSnapshot({
          config,
          env: preparedEnv,
          workspaceDir,
          allowCurrent: false,
        });
        const context = resolvePluginRuntimeLoadContext({
          config,
          activationSourceConfig,
          env: preparedEnv,
          workspaceDir,
          metadataSnapshot,
          logger: params.logger ?? createPluginCliLogger(),
        });
        const captured = revision;
        const prepared: PreparedPluginCliLoad = {
          context,
          withCache,
          assertCurrent() {
            assertRevision(captured);
            if (
              current?.prepared !== prepared ||
              key !== inputKey() ||
              (params.cfg !== undefined && params.cfg !== config) ||
              (params.env ?? process.env) !== env ||
              activationSourceConfig !== resolvePluginActivationSourceConfig({ config }) ||
              current.sdk !== params.loaderOptions?.pluginSdkResolution ||
              current.logger !== params.logger
            ) {
              throw new Error(
                "Plugin CLI preparation inputs changed; start a new registration operation.",
              );
            }
          },
        };
        current = { key, sdk, logger: params.logger, env, prepared };
        prepared.assertCurrent();
        return prepared;
      }),
  };
}

function resolvePreparedPluginCliLoad(params: PluginCliPublicLoadParams): PreparedPluginCliLoad {
  return (params.session ?? createPluginCliLoadSession()).resolve(params);
}

/** Creates the default plugin CLI logger shared with runtime loading. */
export function createPluginCliLogger(): PluginLogger {
  return createPluginRuntimeLoaderLogger();
}

function resolvePrimaryCommandManifestPluginIds(
  context: PluginRuntimeLoadContext,
  primaryCommand: string | undefined,
): string[] | undefined {
  const normalizedPrimary = normalizeLowercaseStringOrEmpty(primaryCommand);
  if (!normalizedPrimary) {
    return undefined;
  }
  return resolveManifestActivationPluginIds({
    trigger: {
      kind: "command",
      command: normalizedPrimary,
    },
    config: context.activationSourceConfig,
    workspaceDir: context.workspaceDir,
    env: context.env,
    manifestRecords: context.manifestRegistry?.plugins,
  });
}

function listPluginCliRootOwnerIds(registry: PluginRegistry, primaryCommand: string): string[] {
  const normalizedPrimary = normalizeLowercaseStringOrEmpty(primaryCommand);
  if (!normalizedPrimary) {
    return [];
  }
  return uniqueStrings(
    registry.cliRegistrars
      .filter((entry) => {
        const parentPath = entry.parentPath ?? [];
        const roots =
          parentPath.length > 0
            ? [parentPath[0]]
            : [...entry.commands, ...entry.descriptors.map((descriptor) => descriptor.name)];
        return roots.includes(normalizedPrimary);
      })
      .map((entry) => entry.pluginId),
  );
}

async function resolvePrimaryCommandPluginIds(
  prepared: PreparedPluginCliLoad,
  primaryCommand: string | undefined,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<string[] | undefined> {
  prepared.assertCurrent();
  const { context } = prepared;
  const normalizedPrimary = normalizeLowercaseStringOrEmpty(primaryCommand);
  if (!normalizedPrimary) {
    return undefined;
  }
  const manifestPluginIds = resolvePrimaryCommandManifestPluginIds(context, normalizedPrimary);
  if (manifestPluginIds && manifestPluginIds.length > 0) {
    return manifestPluginIds;
  }
  const registry = await loadPluginCliMetadataRegistryWithContext(
    prepared,
    { primaryCommand: normalizedPrimary },
    loaderOptions,
  );
  prepared.assertCurrent();
  return listPluginCliRootOwnerIds(registry, normalizedPrimary);
}

async function loadPluginCliMetadataRegistryWithContext(
  prepared: PreparedPluginCliLoad,
  params?: { primaryCommand?: string },
  loaderOptions?: PluginCliLoaderOptions,
): Promise<PluginRegistry> {
  const onlyPluginIds = resolvePrimaryCommandManifestPluginIds(
    prepared.context,
    params?.primaryCommand,
  );
  prepared.assertCurrent();
  const registry = await (prepared.metadataRegistry ??= prepared.withCache(() =>
    loadOpenClawPluginCliRegistry(
      buildPluginRuntimeLoadOptions(prepared.context, {
        ...loaderOptions,
        // The prepared record owns reuse; process caching can retain another generation's registrars.
        cache: false,
        ...(onlyPluginIds && onlyPluginIds.length > 0 ? { onlyPluginIds } : {}),
      }),
    ),
  ));
  prepared.assertCurrent();
  return registry;
}

async function loadPluginCliCommandRegistryWithContext(params: {
  prepared: PreparedPluginCliLoad;
  primaryCommand?: string;
  loaderOptions?: PluginCliLoaderOptions;
}): Promise<PluginRegistry> {
  const { context } = params.prepared;
  let onlyPluginIds: string[] | undefined;
  try {
    onlyPluginIds = await resolvePrimaryCommandPluginIds(
      params.prepared,
      params.primaryCommand,
      params.loaderOptions,
    );
  } catch {
    onlyPluginIds = resolvePrimaryCommandManifestPluginIds(context, params.primaryCommand);
  }
  params.prepared.assertCurrent();
  if (onlyPluginIds && onlyPluginIds.length === 0) {
    return createEmptyPluginRegistry();
  }
  return params.prepared.withCache(() =>
    loadPluginRegistryHandle(
      buildPluginRuntimeLoadOptions(context, {
        ...params.loaderOptions,
        ...(onlyPluginIds && onlyPluginIds.length > 0 ? { onlyPluginIds } : {}),
        cache: false,
        channelPluginLoadIntent: "full",
        runtimeOptions: { nodes: createPluginCliGatewayNodesRuntime() },
      }),
    ),
  );
}

function buildPluginCliCommandGroupEntries(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir: string | undefined;
  logger: PluginLogger;
  assertCurrent: () => void;
  withCache: PreparedPluginCliLoad["withCache"];
}): PluginCliCommandGroupEntry[] {
  return params.registry.cliRegistrars.map((entry) => ({
    pluginId: entry.pluginId,
    parentPath: entry.parentPath ?? [],
    placeholders: entry.descriptors,
    names: entry.commands,
    register: async (program) => {
      params.assertCurrent();
      await params.withCache(() =>
        entry.register({
          program,
          parentPath: entry.parentPath ?? [],
          config: params.config,
          workspaceDir: params.workspaceDir,
          logger: params.logger,
        }),
      );
      params.assertCurrent();
    },
  }));
}

export async function loadPluginCliDescriptors(
  params: PluginCliPublicLoadParams,
): Promise<OpenClawPluginCliRootCommandDescriptor[]> {
  try {
    const prepared = resolvePreparedPluginCliLoad(params);
    const registry = await loadPluginCliMetadataRegistryWithContext(
      prepared,
      { primaryCommand: params.primaryCommand },
      params.loaderOptions,
    );
    return collectUniqueCommandDescriptors(
      registry.cliRegistrars
        .filter((entry) => (entry.parentPath ?? []).length === 0)
        .map((entry) => entry.descriptors),
    );
  } catch (error) {
    // Callers pass a muted per-plugin logger for descriptor scans; a total
    // load failure still removes every plugin command from help/dispatch and
    // must not vanish with it.
    log.warn(`plugin CLI descriptor load failed: ${String(error)}`);
    return [];
  }
}

export async function loadPluginCliRegistrationEntriesWithDefaults(
  params: PluginCliPublicLoadParams,
): Promise<PluginCliCommandGroupEntry[]> {
  const prepared = resolvePreparedPluginCliLoad(params);
  const entries = await (prepared.entries ??= loadPluginCliCommandRegistryWithContext({
    prepared,
    primaryCommand: params.primaryCommand,
    loaderOptions: params.loaderOptions,
  }).then((registry) => {
    prepared.assertCurrent();
    return buildPluginCliCommandGroupEntries({
      ...prepared.context,
      registry,
      assertCurrent: prepared.assertCurrent,
      withCache: prepared.withCache,
    });
  }));
  prepared.assertCurrent();
  return entries;
}

export async function resolvePluginCliRootOwnerIds(
  params: PluginCliPublicLoadParams,
): Promise<string[] | null> {
  const primaryCommand = normalizeLowercaseStringOrEmpty(params.primaryCommand);
  if (!primaryCommand) {
    return null;
  }
  const prepared = resolvePreparedPluginCliLoad(params);
  const ownerIds = await resolvePrimaryCommandPluginIds(
    prepared,
    primaryCommand,
    params.loaderOptions,
  );
  prepared.assertCurrent();
  return ownerIds ?? null;
}

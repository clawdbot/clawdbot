import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginInstanceAdmission } from "./plugin-instance.types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

/** Runtime consumers retain capabilities, never the concrete loader implementation. */
export interface PluginInstanceHandle extends PluginInstanceAdmission {
  readonly pluginId: string;
  readonly owner?: PluginInstanceOwner;
  readonly slots: Map<string | symbol, { runtime: unknown }>;
  sourceDigest?: string;
  toolRegistrationComplete: boolean;
  wrap<T>(value: T): T;
  runCleanup<T>(run: () => T): T;
  bindModuleLoader(
    load: (source: string) => unknown,
    hasSource?: (source: string) => boolean,
  ): void;
  loadModule(source: string): unknown;
  hasModuleSource(source: string): boolean | undefined;
  loadBuiltin(specifier: string, load: (specifier: string) => unknown): unknown;
  prepareGlobals(load: (specifier: string) => unknown): Record<string, unknown>;
  quiesce(): boolean;
  drain(): Promise<void>;
  resume(): void;
  dispose(beforeCleanup?: () => void | Promise<void>): Promise<void>;
}

export type PluginInstanceOwner = {
  record: PluginRecord;
  registry: PluginRegistry;
  revoked: boolean;
  instance?: PluginInstanceHandle;
};
// SDK source transforms and native core chunks must observe the same exact owner.
export const pluginInstanceState = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceState"),
  () => ({
    records: new WeakMap<PluginRecord, PluginInstanceOwner>(),
    values: new WeakMap<object, PluginInstanceHandle>(),
    invocation: new AsyncLocalStorage<{ instance: PluginInstanceHandle; token: object }>(),
    resourceInvocation: new AsyncLocalStorage<object | undefined>(),
  }),
);

export function resolvePluginInstanceOwner(record: PluginRecord, registry: PluginRegistry) {
  let owner = pluginInstanceState.records.get(record);
  if (!owner) {
    owner = { record, registry, revoked: false };
    pluginInstanceState.records.set(record, owner);
  }
  return owner;
}

/** Direct SDK registrars retain the same owner as registrations made through api. */
export function wrapCurrentPluginInstance<T>(value: T, host?: (value: T) => T): T {
  const owner = pluginInstanceState.invocation.getStore()?.instance;
  return owner ? owner.wrap(value) : host ? host(value) : value;
}

/** Teardown admission comes from the host owner, never a plugin method name. */
export function runPluginCleanup<T>(value: object, run: () => T): T {
  const instance = pluginInstanceState.values.get(value);
  return instance ? instance.runCleanup(run) : run();
}

/** Named SDK slots share only within the exact managed plugin instance. */
export function getPluginInstanceRuntimeSlot(
  key: string | symbol,
): { runtime: unknown } | undefined {
  const owner = pluginInstanceState.invocation.getStore()?.instance;
  if (!owner) {
    return undefined;
  }
  let slot = owner.slots.get(key);
  if (!slot) {
    owner.slots.set(key, (slot = { runtime: null }));
  }
  return slot;
}

export function getPluginInstance(record: PluginRecord): PluginInstanceHandle | undefined {
  return pluginInstanceState.records.get(record)?.instance;
}

/** Exact owner of a callable public view; never inferred from a plugin id or path. */
export function getPluginValueInstance(value: object): PluginInstanceHandle | undefined {
  return pluginInstanceState.values.get(value);
}

/** Shared reference accounting; registration owners decide when and how to dispose. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginRuntimeLifecycleRegistration } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";

export type RegistrationResourceOwner = {
  registry: PluginRegistry;
  kind: "scoped" | "root";
  references: number;
  disposing: boolean;
  onUnreferenced(): void;
  disposers: Map<PluginRuntimeLifecycleRegistration, string>;
  completion?: Promise<void>;
  failures: Error[];
  registrations: Set<Promise<void>>;
};

export const pluginRegistryResourceState = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryResources"),
  () => ({
    owners: new WeakMap<PluginRegistry, readonly RegistrationResourceOwner[]>(),
    aliases: new WeakMap<PluginRegistry, { source: PluginRegistry; signal: AbortSignal }>(),
    pending: new Set<Promise<void>>(),
    failures: new Array<Error>(),
    overflowFailures: 0,
  }),
);

/** A resource claim grants no execution authority and can be released exactly once. */
export type PluginRegistryResourceClaim = { release: () => void };

/** Source facts are weakly keyed by alias; cached sources never retain historical aliases. */
export function getPluginRegistryResourceAlias(
  registry: PluginRegistry,
): Readonly<{ source: PluginRegistry; signal: AbortSignal }> | undefined {
  return pluginRegistryResourceState.aliases.get(registry);
}

/** Retains the exact registration instances used by a cache, build, publication, or operation. */
export function retainPluginRegistryResources(
  registry: PluginRegistry,
): PluginRegistryResourceClaim {
  const owners = pluginRegistryResourceState.owners.get(registry) ?? [];
  if (owners.some((owner) => owner.disposing)) {
    throw new Error("Plugin registry resources have been disposed");
  }
  for (const owner of owners) {
    owner.references += 1;
  }
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      for (const owner of owners) {
        owner.references -= 1;
        if (owner.references === 0) {
          owner.onUnreferenced();
        }
      }
    },
  };
}

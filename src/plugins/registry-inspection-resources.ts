import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

type RegistrationDisposer = { id: string; dispose: () => void | Promise<void> };
type RegistrationResources = {
  disposers: RegistrationDisposer[];
  disposal?: Promise<Error[]>;
};

// Registrars and loaders can come from different source/built module copies.
const inspections = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryInspectionResources"),
  () => new WeakMap<PluginRegistry, PluginRegistryInspectionResources>(),
);

export function getPluginRegistryInspectionResources(registry: PluginRegistry) {
  return inspections.get(registry);
}

/** Owns only an explicitly acquired, uncached inspection's registration resources. */
export class PluginRegistryInspectionResources {
  readonly #registrations = new Map<string, RegistrationResources>();
  readonly #pending = new Set<Promise<void>>();
  #registry?: PluginRegistry;
  #release?: Promise<void>;

  attach(registry: PluginRegistry): void {
    this.#registry = registry;
    inspections.set(registry, this);
  }

  #registration(pluginId: string): RegistrationResources {
    let entry = this.#registrations.get(pluginId);
    if (!entry) {
      entry = { disposers: [] };
      this.#registrations.set(pluginId, entry);
    }
    return entry;
  }

  register(pluginId: string, disposer: RegistrationDisposer): void {
    this.#registration(pluginId).disposers.push(disposer);
  }

  trackRegistration(pending: Promise<unknown>): void {
    const completion = pending.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(completion);
    void completion.then(() => this.#pending.delete(completion));
  }

  rollback(pluginId: string): void {
    const entry = this.#registrations.get(pluginId);
    if (entry) {
      void this.#dispose(pluginId, entry);
    }
  }

  async #waitForRegistrations(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
  }

  #dispose(pluginId: string, entry: RegistrationResources): Promise<Error[]> {
    return (entry.disposal ??= Promise.resolve().then(async () => {
      // An invalid async registration can still use a sibling's resources in this inspection.
      await this.#waitForRegistrations();
      const failures: Error[] = [];
      const disposers = entry.disposers.splice(0);
      for (const { id, dispose } of disposers) {
        try {
          await dispose();
        } catch (cause) {
          failures.push(
            new Error(`Plugin inspection disposal failed: ${pluginId}:${id}`, { cause }),
          );
        }
      }
      return failures;
    }));
  }

  release(): Promise<void> {
    if (!this.#release) {
      // Revocation can call back into release through synchronous abort listeners.
      this.#release = Promise.resolve()
        .then(async () => {
          await this.#waitForRegistrations();
          return Promise.all(
            [...this.#registrations].map(([pluginId, entry]) => this.#dispose(pluginId, entry)),
          );
        })
        .then((results) => {
          const failures = results.flat();
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              "Plugin inspection resources could not all be disposed",
            );
          }
        });
      if (this.#registry) {
        markPluginRegistryRetired(this.#registry);
      }
    }
    return this.#release;
  }
}

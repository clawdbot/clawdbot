/** Keeps plugin service failures scoped to the registry generation that owns them. */
import { formatErrorMessage } from "../infra/errors.js";
import type { OpenClawPluginServiceHealth } from "./plugin-registration.types.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";

type PluginServiceHealthFailure = {
  pluginId: string;
  serviceId: string;
  origin: PluginServiceRegistration["origin"];
  error: string;
};

const states = new WeakMap<
  PluginRegistry,
  { generation: symbol; failures: Map<string, PluginServiceHealthFailure> }
>();

export function createPluginServiceHealthGeneration(registry: PluginRegistry) {
  const generation = Symbol("plugin-service-health-generation");
  const state = { generation, failures: new Map<string, PluginServiceHealthFailure>() };
  states.set(registry, state);
  const ownsGeneration = () => states.get(registry)?.generation === generation;

  return {
    createReporter(service: PluginServiceRegistration): {
      health: OpenClawPluginServiceHealth;
      revoke: () => void;
    } {
      let active = true;
      const canReport = () => active && ownsGeneration();
      return {
        health: {
          reportFailure: (error) => {
            if (!canReport()) {
              return;
            }
            state.failures.set(service.service.id, {
              pluginId: service.pluginId,
              serviceId: service.service.id,
              origin: service.origin,
              error: formatErrorMessage(error),
            });
          },
          clearFailure: () => {
            if (canReport()) {
              state.failures.delete(service.service.id);
            }
          },
        },
        revoke: () => {
          active = false;
        },
      };
    },
    retire: () => {
      if (ownsGeneration()) {
        states.delete(registry);
      }
    },
  };
}

export function listPluginServiceHealthFailures(
  registry: PluginRegistry,
): PluginServiceHealthFailure[] {
  return [...(states.get(registry)?.failures.values() ?? [])].toSorted(
    (left, right) =>
      left.pluginId.localeCompare(right.pluginId) || left.serviceId.localeCompare(right.serviceId),
  );
}

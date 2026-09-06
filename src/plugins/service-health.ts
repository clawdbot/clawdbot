/** Health belongs to the exact service instance, including across registry publications. */
import { formatErrorMessage } from "../infra/errors.js";
import type { OpenClawPluginServiceHealth } from "./plugin-registration.types.js";
import type { PluginServiceRegistration, PluginRegistry } from "./registry-types.js";

type PluginServiceHealthFailure = {
  pluginId: string;
  serviceId: string;
  origin: PluginServiceRegistration["origin"];
  error: string;
};

const states = new WeakMap<PluginServiceRegistration, { failure?: PluginServiceHealthFailure }>();

export function createPluginServiceHealthReporter(service: PluginServiceRegistration): {
  health: OpenClawPluginServiceHealth;
  revoke: () => void;
} {
  const state: { failure?: PluginServiceHealthFailure } = {};
  states.set(service, state);
  let active = true;
  const canReport = () => active && states.get(service) === state;
  return {
    health: {
      reportFailure: (error) => {
        if (canReport()) {
          state.failure = {
            pluginId: service.pluginId,
            serviceId: service.service.id,
            origin: service.origin,
            error: formatErrorMessage(error),
          };
        }
      },
      clearFailure: () => {
        if (canReport()) {
          delete state.failure;
        }
      },
    },
    revoke: () => {
      active = false;
    },
  };
}

export function listPluginServiceHealthFailures(
  registry: PluginRegistry,
): PluginServiceHealthFailure[] {
  return registry.services
    .flatMap((service) => {
      const failure = states.get(service)?.failure;
      return failure ? [failure] : [];
    })
    .toSorted(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) ||
        left.serviceId.localeCompare(right.serviceId),
    );
}

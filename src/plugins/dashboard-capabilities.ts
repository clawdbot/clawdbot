import {
  BOARD_CRON_TRIGGER_PREFIX,
  BOARD_DATA_BINDING_ID_MAX_LENGTH,
  BOARD_WIDGET_TOOL_MAX_LENGTH,
} from "../../packages/gateway-protocol/src/index.js";
import { CORE_BOARD_HOST_CAPABILITY_IDS } from "../boards/board-host-capability-ids.js";
import type {
  PluginDashboardActionVerbRegistration,
  PluginDashboardDataBindingRegistration,
  PluginRecord,
  PluginRegistry,
} from "./registry-types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";

export class PluginDashboardDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDashboardDeclarationError";
  }
}

function fail(pluginId: string, message: string): never {
  throw new PluginDashboardDeclarationError(
    `invalid dashboard declaration for plugin ${JSON.stringify(pluginId)}: ${message}`,
  );
}

function buildCapabilityId(params: {
  pluginId: string;
  localId: string;
  maxLength: number;
}): string {
  // Grants outlive plugin activation. Escape the owner delimiter and escape marker so
  // different plugin/local-id splits cannot reuse one persisted authorization string.
  const pluginIdSegment = params.pluginId.replaceAll("%", "%25").replaceAll(".", "%2E");
  const capabilityId = `${pluginIdSegment}.${params.localId}`;
  if (capabilityId.length > params.maxLength) {
    return fail(
      params.pluginId,
      `capability id ${JSON.stringify(capabilityId)} exceeds ${params.maxLength} characters`,
    );
  }
  return capabilityId;
}

function requireOwnedMethod(params: {
  pluginId: string;
  method: string;
  expectedScope: "operator.read" | "operator.write";
  registry: PluginRegistry;
}) {
  const descriptor = params.registry.gatewayMethodDescriptors.find(
    (candidate) => candidate.name === params.method,
  );
  if (descriptor?.owner.kind !== "plugin" || descriptor.owner.pluginId !== params.pluginId) {
    return fail(
      params.pluginId,
      `method ${JSON.stringify(params.method)} must be registered by the declaring plugin`,
    );
  }
  if (descriptor.scope !== params.expectedScope) {
    return fail(
      params.pluginId,
      `method ${JSON.stringify(params.method)} must use ${params.expectedScope}, got ${descriptor.scope}`,
    );
  }
  const handler = params.registry.gatewayHandlers[params.method];
  if (!handler) {
    return fail(
      params.pluginId,
      `method ${JSON.stringify(params.method)} is missing its registered handler`,
    );
  }
  return handler;
}

/** Validates and publishes one plugin's manifest-declared dashboard capabilities atomically. */
export function registerPluginDashboardCapabilities(params: {
  record: PluginRecord;
  registry: PluginRegistry;
}): void {
  const dashboard = params.record.dashboard;
  if (!dashboard) {
    return;
  }

  const dataBindings: PluginDashboardDataBindingRegistration[] = [];
  const actionVerbs: PluginDashboardActionVerbRegistration[] = [];
  const capabilityIds = new Set<string>();
  const claimCapabilityId = (capabilityId: string): void => {
    if (
      capabilityIds.has(capabilityId) ||
      params.registry.dashboardDataBindings.has(capabilityId) ||
      params.registry.dashboardActionVerbs.has(capabilityId)
    ) {
      fail(params.record.id, `duplicate capability id ${JSON.stringify(capabilityId)}`);
    }
    if (
      (CORE_BOARD_HOST_CAPABILITY_IDS as readonly string[]).includes(capabilityId) ||
      capabilityId.startsWith(BOARD_CRON_TRIGGER_PREFIX)
    ) {
      fail(params.record.id, `capability id ${JSON.stringify(capabilityId)} is reserved by core`);
    }
    capabilityIds.add(capabilityId);
  };

  for (const declaration of dashboard.dataBindings ?? []) {
    const capabilityId = buildCapabilityId({
      pluginId: params.record.id,
      localId: declaration.id,
      maxLength: BOARD_DATA_BINDING_ID_MAX_LENGTH,
    });
    claimCapabilityId(capabilityId);
    dataBindings.push({
      ...declaration,
      pluginId: params.record.id,
      capabilityId,
      handler: requireOwnedMethod({
        pluginId: params.record.id,
        method: declaration.method,
        expectedScope: "operator.read",
        registry: params.registry,
      }),
    });
  }

  for (const declaration of dashboard.actionVerbs ?? []) {
    const capabilityId = buildCapabilityId({
      pluginId: params.record.id,
      localId: declaration.id,
      maxLength: BOARD_WIDGET_TOOL_MAX_LENGTH,
    });
    claimCapabilityId(capabilityId);
    const handler = requireOwnedMethod({
      pluginId: params.record.id,
      method: declaration.method,
      expectedScope: "operator.write",
      registry: params.registry,
    });
    if (declaration.paramShape) {
      try {
        validateJsonSchemaValue({
          schema: declaration.paramShape,
          cacheKey: `dashboard-action:${params.record.id}:${declaration.id}`,
          value: undefined,
        });
      } catch (error) {
        fail(
          params.record.id,
          `action ${JSON.stringify(capabilityId)} has an invalid paramShape: ${String(error)}`,
        );
      }
    }
    actionVerbs.push({
      ...declaration,
      pluginId: params.record.id,
      capabilityId,
      handler,
    });
  }

  for (const registration of dataBindings) {
    params.registry.dashboardDataBindings.set(registration.capabilityId, registration);
  }
  for (const registration of actionVerbs) {
    params.registry.dashboardActionVerbs.set(registration.capabilityId, registration);
  }
}

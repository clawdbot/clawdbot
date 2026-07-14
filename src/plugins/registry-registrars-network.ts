import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createPluginGatewayMethodDescriptor } from "../gateway/methods/registry.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler, RespondFn } from "../gateway/server-methods/types.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import {
  resolvePluginRegistrationCapabilities,
  type PluginRegistryState,
} from "./registry-state.js";
import type { PluginHttpRouteRegistration, PluginRecord } from "./registry-types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type {
  OpenClawPluginChannelRegistration,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteParams,
  PluginRegistrationMode,
} from "./types.js";

const GATEWAY_METHOD_DISPATCH_CONTRACT = "authenticated-request";

function adaptPluginGatewayMethodHandler(handler: GatewayRequestHandler): GatewayRequestHandler {
  return async (opts) => {
    let responded = false;
    const respond: RespondFn = (ok, payload, error, meta) => {
      responded = true;
      opts.respond(ok, payload, error, meta);
    };
    const result = (await handler({ ...opts, respond })) as unknown;
    if (!responded && result !== undefined) {
      respond(true, result);
    }
  };
}

export function createNetworkRegistrars(state: PluginRegistryState) {
  const { registry, coreGatewayMethods, pluginsWithChannelRegistrationConflict, pushDiagnostic } =
    state;

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope },
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway method already registered: ${trimmed}`,
      });
      return;
    }
    const wrappedHandler = adaptPluginGatewayMethodHandler(handler);
    registry.gatewayHandlers[trimmed] = wrappedHandler;
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
      });
    }
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: record.id,
        name: trimmed,
        handler: wrappedHandler,
        scope: normalizedScope.scope,
      }),
    );
  };

  const registerSessionCatalog = (record: PluginRecord, provider: SessionCatalogProvider) => {
    const id = provider.id.trim();
    const label = provider.label.trim();
    if (!id || !label) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session catalog requires non-empty id and label",
      });
      return;
    }
    const existing = registry.sessionCatalogs.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session catalog already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    registry.sessionCatalogs.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: { ...provider, id, label },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const describeHttpRouteOwner = (entry: PluginHttpRouteRegistration): string => {
    const plugin = normalizeOptionalString(entry.pluginId) || "unknown-plugin";
    const source = normalizeOptionalString(entry.source) || "unknown-source";
    return `${plugin} (${source})`;
  };

  const canDispatchGatewayMethodsFromHttpRoute = (record: PluginRecord): boolean =>
    (record.contracts?.gatewayMethodDispatch ?? []).includes(GATEWAY_METHOD_DISPATCH_CONTRACT);

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const normalizedPath = normalizePluginHttpPath(params.path);
    if (!normalizedPath) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "http route registration missing path",
      });
      return;
    }
    if (params.auth !== "gateway" && params.auth !== "plugin") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route registration missing or invalid auth: ${normalizedPath}`,
      });
      return;
    }
    const match = params.match ?? "exact";
    const overlappingRoute = findOverlappingPluginHttpRoute(registry.httpRoutes, {
      path: normalizedPath,
      match,
    });
    if (overlappingRoute && overlappingRoute.auth !== params.auth) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) ` +
          `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
          `owned by ${describeHttpRouteOwner(overlappingRoute)}`,
      });
      return;
    }
    const existingIndex = registry.httpRoutes.findIndex(
      (entry) => entry.path === normalizedPath && entry.match === match,
    );
    const registration = {
      pluginId: record.id,
      path: normalizedPath,
      handler: params.handler,
      ...(params.handleUpgrade ? { handleUpgrade: params.handleUpgrade } : {}),
      auth: params.auth,
      match,
      ...(params.gatewayRuntimeScopeSurface
        ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
        : {}),
      ...(canDispatchGatewayMethodsFromHttpRoute(record)
        ? { gatewayMethodDispatchAllowed: true }
        : {}),
      ...(params.nodeCapability ? { nodeCapability: { ...params.nodeCapability } } : {}),
      source: record.source,
    } satisfies PluginHttpRouteRegistration;
    if (existingIndex >= 0) {
      const existing = registry.httpRoutes[existingIndex];
      if (!existing) {
        return;
      }
      if (!params.replaceExisting && existing.pluginId !== record.id) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`,
        });
        return;
      }
      if (existing.pluginId && existing.pluginId !== record.id) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`,
        });
        return;
      }
      registry.httpRoutes[existingIndex] = registration;
      return;
    }
    record.httpRoutes += 1;
    registry.httpRoutes.push(registration);
  };

  const registerHostedMediaResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginHostedMediaResolver,
  ) => {
    if (typeof resolver !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "hosted media resolver registration missing resolver",
      });
      return;
    }
    registry.hostedMediaResolvers.push({
      pluginId: record.id,
      pluginName: record.name,
      resolver,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
    mode: PluginRegistrationMode = "full",
  ) => {
    if (record.origin === "workspace" && !record.enabled) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `channel registration rejected for disabled workspace plugin: ${record.id}`,
      });
      return;
    }
    const registrationCapabilities = resolvePluginRegistrationCapabilities(mode);
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalizeRegisteredChannelPlugin({
      pluginId: record.id,
      source: record.source,
      plugin: normalized.plugin,
      pushDiagnostic,
    });
    if (!plugin) {
      return;
    }
    const id = plugin.id;
    const existingRuntime = registry.channels.find((entry) => entry.plugin.id === id);
    if (registrationCapabilities.runtimeChannel && existingRuntime) {
      if (existingRuntime.pluginId === record.id) {
        existingRuntime.plugin = plugin;
        existingRuntime.pluginName = record.name;
        existingRuntime.origin = record.origin;
        existingRuntime.source = record.source;
        existingRuntime.rootDir = record.rootDir;
        const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
        if (existingSetup) {
          existingSetup.plugin = plugin;
          existingSetup.pluginName = record.name;
          existingSetup.origin = record.origin;
          existingSetup.source = record.source;
          existingSetup.enabled = record.enabled;
          existingSetup.rootDir = record.rootDir;
        }
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel already registered: ${id} (${existingRuntime.pluginId})`,
      });
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    if (existingSetup) {
      if (existingSetup.pluginId === record.id) {
        existingSetup.plugin = plugin;
        existingSetup.pluginName = record.name;
        existingSetup.origin = record.origin;
        existingSetup.source = record.source;
        existingSetup.enabled = record.enabled;
        existingSetup.rootDir = record.rootDir;
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel setup already registered: ${id} (${existingSetup.pluginId})`,
      });
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    if (!record.channelIds.includes(id)) {
      record.channelIds.push(id);
    }
    registry.channelSetups.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      origin: record.origin,
      source: record.source,
      enabled: record.enabled,
      rootDir: record.rootDir,
    });
    if (!registrationCapabilities.runtimeChannel) {
      return;
    }
    registry.channels.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  return {
    registerGatewayMethod,
    registerSessionCatalog,
    registerHttpRoute,
    registerHostedMediaResolver,
    registerChannel,
  };
}

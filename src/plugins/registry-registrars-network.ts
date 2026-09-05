import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodProfileAccess,
} from "../gateway/methods/descriptor.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler, RespondFn } from "../gateway/server-methods/types.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import { getPluginHttpRouteViews, replacePluginHttpRoutes } from "./http-route-owner.js";
import { wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import {
  resolvePluginRegistrationCapabilities,
  type PluginRegistryState,
} from "./registry-state.js";
import type {
  PluginChannelRegistration,
  PluginHttpRouteRegistration,
  PluginRecord,
} from "./registry-types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type {
  OpenClawPluginChannelRegistration,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginMcpServerConnectionResolver,
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
  const {
    registry,
    createRegistration,
    coreGatewayMethods,
    pluginsWithChannelRegistrationConflict,
    pushDiagnostic,
    reportRegistrationError,
    reportRegistrationWarning,
  } = state;
  let reportedLegacyCatalogSkip = false;

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope; profileAccess?: GatewayMethodProfileAccess },
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      reportRegistrationError(record, `gateway method already registered: ${trimmed}`);
      return;
    }
    const wrappedHandler = adaptPluginGatewayMethodHandler(handler);
    registry.gatewayHandlers[trimmed] = wrappedHandler;
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      reportRegistrationWarning(
        record,
        `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
      );
    }
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: record.id,
        name: trimmed,
        handler: wrappedHandler,
        scope: normalizedScope.scope,
        ...(opts?.profileAccess ? { profileAccess: opts.profileAccess } : {}),
      }),
    );
  };

  const registerSessionCatalog = (record: PluginRecord, provider: SessionCatalogProvider) => {
    const id = provider.id.trim();
    const label = provider.label.trim();
    if (!id || !label) {
      reportRegistrationError(record, "session catalog requires non-empty id and label");
      return;
    }
    if (!state.allowProcessHomeSessionCatalogs && provider.supportsProcessHomeIsolation !== true) {
      if (!reportedLegacyCatalogSkip) {
        reportedLegacyCatalogSkip = true;
        reportRegistrationWarning(
          record,
          "external session catalog skipped in isolated state: provider must declare supportsProcessHomeIsolation",
        );
      }
      return;
    }
    const existing = registry.sessionCatalogs.find((entry) => entry.provider.id === id);
    if (existing) {
      reportRegistrationError(
        record,
        `session catalog already registered: ${id} (${existing.pluginId})`,
      );
      return;
    }
    registry.sessionCatalogs.push(
      createRegistration(record, {
        provider: { ...provider, id, label },
      }),
    );
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
      reportRegistrationWarning(record, "http route registration missing path");
      return;
    }
    if (params.auth !== "gateway" && params.auth !== "plugin") {
      reportRegistrationError(
        record,
        `http route registration missing or invalid auth: ${normalizedPath}`,
      );
      return;
    }
    const match = params.match ?? "exact";
    const { authOverlap, canonicalMatches } = findPluginHttpRouteRegistrationConflicts(
      [...new Set(getPluginHttpRouteViews(registry, record.id).flatMap((view) => view.httpRoutes))],
      {
        path: normalizedPath,
        match,
        auth: params.auth,
      },
    );
    if (authOverlap) {
      reportRegistrationError(
        record,
        `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) ` +
          `overlaps ${authOverlap.path} (${authOverlap.match}, ${authOverlap.auth}) ` +
          `owned by ${describeHttpRouteOwner(authOverlap)}`,
      );
      return;
    }
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
    const foreignOwner = canonicalMatches.find((route) => route.pluginId !== record.id);
    if (foreignOwner) {
      reportRegistrationError(
        record,
        params.replaceExisting
          ? `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(foreignOwner)}`
          : `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(foreignOwner)}`,
      );
      return;
    }
    if (!canonicalMatches.length) {
      record.httpRoutes += 1;
    }
    replacePluginHttpRoutes(registry, registration, canonicalMatches, true);
  };

  const registerHostedMediaResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginHostedMediaResolver,
  ) => {
    if (typeof resolver !== "function") {
      reportRegistrationError(record, "hosted media resolver registration missing resolver");
      return;
    }
    registry.hostedMediaResolvers.push(
      createRegistration(record, {
        resolver,
      }),
    );
  };

  const registerMcpServerConnectionResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginMcpServerConnectionResolver,
  ) => {
    const serverName = normalizeOptionalString(resolver?.serverName);
    if (!serverName || typeof resolver.resolve !== "function") {
      reportRegistrationError(
        record,
        "MCP server connection resolver registration missing serverName or resolve",
      );
      return;
    }
    const existingIndex = registry.mcpServerConnectionResolvers.findIndex(
      (entry) => entry.resolver.serverName === serverName,
    );
    const registration = createRegistration(record, {
      resolver: {
        serverName,
        resolve: resolver.resolve,
      },
    });
    if (existingIndex >= 0) {
      const existing = registry.mcpServerConnectionResolvers[existingIndex];
      // Resolver ownership is an authorization boundary: connection identity
      // must not depend on plugin load order. First registration wins; a
      // duplicate from another plugin is rejected, not silently replaced.
      if (existing && existing.pluginId !== record.id) {
        reportRegistrationError(
          record,
          `MCP server connection resolver for "${serverName}" rejected: already registered by plugin "${existing.pluginId}"`,
        );
        return;
      }
      registry.mcpServerConnectionResolvers[existingIndex] = registration;
      return;
    }
    registry.mcpServerConnectionResolvers.push(registration);
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
    mode: PluginRegistrationMode = "full",
    resolveChannelRuntime?: PluginChannelRegistration["resolveChannelRuntime"],
  ) => {
    if (record.origin === "workspace" && !record.enabled) {
      reportRegistrationWarning(
        record,
        `channel registration rejected for disabled workspace plugin: ${record.id}`,
      );
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
    const existingRuntime = registrationCapabilities.runtimeChannel
      ? registry.channels.find((entry) => entry.plugin.id === id)
      : undefined;
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    const existing = existingRuntime ?? existingSetup;
    if (existing && existing.pluginId !== record.id) {
      reportRegistrationError(
        record,
        `${existingRuntime ? "channel" : "channel setup"} already registered: ${id} (${existing.pluginId})`,
      );
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    const metadata = {
      // Normalization copied the input; teardown must retain its registration owner.
      plugin: wrapCurrentPluginInstance(plugin),
      pluginName: record.name,
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    };
    if (existing) {
      if (existingRuntime) {
        Object.assign(existingRuntime, metadata, { resolveChannelRuntime });
      }
      if (existingSetup) {
        Object.assign(existingSetup, metadata, { enabled: record.enabled });
      }
      return;
    }
    if (!record.channelIds.includes(id)) {
      record.channelIds.push(id);
    }
    registry.channelSetups.push({ ...metadata, pluginId: record.id, enabled: record.enabled });
    if (registrationCapabilities.runtimeChannel) {
      registry.channels.push({ ...metadata, pluginId: record.id, resolveChannelRuntime });
    }
  };

  return {
    registerGatewayMethod,
    registerSessionCatalog,
    registerHttpRoute,
    registerHostedMediaResolver,
    registerMcpServerConnectionResolver,
    registerChannel,
  };
}

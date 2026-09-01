import type {
  ControlUiDisposer,
  ControlUiHost,
  ControlUiPageNavigationOptions,
  ControlUiPageTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import type { RouteId } from "../app-route-paths.ts";
import { isRouteId, pathForRoute } from "../app-route-paths.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../app/operator-access.ts";
import { i18n } from "../i18n/index.ts";
import { redactToolPayloadText } from "../lib/browser-redact.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import { normalizeSessionKeyForUiComparison } from "../lib/sessions/session-key.ts";
import { createControlUiComponents } from "./control-ui-components.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

export function createControlUiPluginHost(
  getContext: () => ApplicationContext<RouteId>,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
): ControlUiHost {
  const current = () => {
    if (!runtime.isCurrent(owner)) {
      throw new Error("This plugin UI activation has ended. Use the current activation.");
    }
    return getContext();
  };
  const retain = (dispose: ControlUiDisposer) => {
    if (!runtime.isCurrent(owner)) {
      dispose();
      current();
    }
    owner.disposers.add(dispose);
    return () => {
      owner.disposers.delete(dispose);
      dispose();
    };
  };
  const call = async <T>(operation: (context: ApplicationContext<RouteId>) => Promise<T>) => {
    const result = await operation(current());
    current();
    return result;
  };
  const pageLocation = (
    target: ControlUiPageTarget,
    options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
  ) => {
    const context = current();
    const tab = context.gateway.snapshot.hello?.controlUiTabs?.find(
      (candidate) => candidate.pluginId === owner.descriptor.pluginId && candidate.id === target.id,
    );
    const route = tab?.placement?.startsWith("route:")
      ? tab.placement.slice("route:".length)
      : null;
    const nativeRoute = route && isRouteId(route) ? route : null;
    const path = pathForRoute(nativeRoute ?? "plugin", context.basePath);
    const suffix = nativeRoute ? target.path?.map(encodeURIComponent).join("/") : undefined;
    const search = new URLSearchParams(options?.preserveSearch ? window.location.search : "");
    if (!nativeRoute) {
      search.set("plugin", owner.descriptor.pluginId);
      search.set("id", target.id);
    }
    for (const [key, value] of Object.entries(target.params ?? {})) {
      search.set(`p.${key}`, value);
    }
    return {
      route: nativeRoute ?? ("plugin" as const),
      pathname: suffix ? `${path}/${suffix}` : path,
      search: search.size ? `?${search}` : "",
    };
  };
  return {
    apiVersion: 1,
    pluginId: owner.descriptor.pluginId,
    signal: owner.abort.signal,
    get basePath() {
      return current().basePath;
    },
    get locale() {
      return i18n.getLocale();
    },
    redact: redactToolPayloadText,
    components: createControlUiComponents({
      current,
      signal: owner.abort.signal,
      onError: (error) => runtime.reportError(owner.descriptor.pluginId, error),
    }),
    get connection() {
      const snapshot = current().gateway.snapshot;
      const access = readGatewayOperatorAccess(snapshot);
      return {
        connected: snapshot.phase === "connected",
        canRead: hasOperatorReadAccess(snapshot.hello?.auth ?? null),
        canWrite: access.canWrite,
        canGrant: access.canGrantApprovals,
        canAdmin: access.canAdmin,
        assistantAgentId: snapshot.assistantAgentId,
      };
    },
    request: (method, params = {}) => call(() => owner.client.request(method, params)),
    onEvent(event, listener) {
      return retain(
        current().gateway.subscribeEvents((frame) => {
          if (runtime.isCurrent(owner) && frame.event === event) {
            listener(frame.payload);
          }
        }),
      );
    },
    subscribe(listener) {
      const context = current();
      const notify = () => {
        if (runtime.isCurrent(owner)) {
          listener();
        }
      };
      const stops = [
        context.gateway.subscribe(notify),
        context.sessions.subscribe(notify),
        context.agents.subscribe(notify),
        context.agentSelection.subscribe(notify),
        context.theme.subscribe(notify),
        i18n.subscribe(notify),
      ];
      return retain(() => stops.forEach((stop) => stop()));
    },
    sessions: {
      get rows() {
        return structuredClone(current().sessions.state.result?.sessions ?? []);
      },
      get selectedKey() {
        return current().gateway.snapshot.sessionKey;
      },
      normalizeKey: normalizeSessionKeyForUiComparison,
      refresh: () =>
        call(async (context) => {
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error("The session refresh did not complete. Try again.");
          }
        }),
      observe(query, listener) {
        const { archived, ...options } = query;
        let disposed = false;
        const observer = current().sessions.observeList(
          {
            ...options,
            archivedFilter: archived === "all" ? "all" : archived ? "archived" : "active",
          },
          ({ result, loading, error }) => {
            if (disposed || !runtime.isCurrent(owner)) {
              return;
            }
            try {
              listener({
                loading,
                error,
                result: result
                  ? {
                      sessions: structuredClone(result.sessions),
                      hasMore: result.hasMore,
                      nextOffset: result.nextOffset,
                      totalCount: result.totalCount,
                    }
                  : null,
              });
            } catch (listenerError) {
              runtime.reportError(owner.descriptor.pluginId, listenerError);
            }
          },
        );
        const dispose = retain(() => {
          disposed = true;
          observer.dispose();
        });
        const refresh = () => call(() => observer.refresh());
        void refresh().catch((error: unknown) => {
          if (!disposed && runtime.isCurrent(owner)) {
            runtime.reportError(owner.descriptor.pluginId, error);
          }
        });
        return { refresh, dispose };
      },
      open({ sessionKey, agentId }) {
        const context = current();
        const face = resolveSessionPreferredFaceForKey(context, sessionKey, agentId);
        const target = sessionNavigationTarget({
          context,
          face,
          sessionKey,
          agentId,
          preferenceDerivedFace: true,
          exactKey: true,
        });
        selectApplicationSession({
          selection: context.agentSelection,
          gateway: context.gateway,
          sessionKey,
          agentId,
        });
        context.navigate(face, target.options);
      },
      create: (params) => call((context) => context.sessions.create(params)),
      patch: ({ sessionKey, agentId }, patch) =>
        call(async (context) => {
          // A plugin query may target another global owner. Its mutation does not
          // own the primary roster's optimistic model or remembered list scope.
          const result = await context.sessions.patch(sessionKey, patch, {
            agentId,
            ownsModelOverride: () => false,
            deferListRefresh: true,
          });
          if (!result) {
            throw new Error("The session update did not complete. Try again.");
          }
          current();
          if ((await context.sessions.refreshReplacement()) === null) {
            throw new Error(
              "The session was updated, but the session list could not be refreshed. Refresh the list to see the change.",
            );
          }
        }),
    },
    agents: {
      get rows() {
        return structuredClone(current().agents.state.agentsList?.agents ?? []);
      },
      get selectedId() {
        return current().agentSelection.state.selectedId;
      },
      get defaultId() {
        return current().agents.state.agentsList?.defaultId ?? null;
      },
      get scopeId() {
        return current().agentSelection.state.scopeId;
      },
      select(agentId) {
        current().agentSelection.set(agentId);
      },
      setScope(agentId) {
        current().agentSelection.setScope(agentId);
      },
      refresh: () =>
        call(async (context) => {
          if ((await context.agents.refreshList()) === null) {
            throw new Error("The agent refresh did not complete. Try again.");
          }
        }),
    },
    navigation: {
      openPage(target, options) {
        const location = pageLocation(target, options);
        const context = current();
        if (options?.replace) {
          context.replace(location.route, location);
        } else {
          context.navigate(location.route, location);
        }
      },
      pageHref(target, options) {
        const location = pageLocation(target, options);
        return `${location.pathname}${location.search}`;
      },
    },
    ui: {
      invalidate: () => runtime.invalidate(owner),
      registerPage: (value) => runtime.register(owner, "pages", value),
      registerNavigation: (value) => runtime.register(owner, "navigation", value),
      registerPanel: (value) => runtime.register(owner, "panels", value),
      registerAction: (value) => runtime.register(owner, "actions", value),
      registerAccessory: (value) => runtime.register(owner, "accessories", value),
      registerWidget: (value) => runtime.register(owner, "widgets", value),
      registerReplacement: (value) => runtime.register(owner, "replacements", value),
      selectReplacement(surface, id) {
        current();
        if (id !== null && owner.contributions.replacements.get(id)?.value.surface !== surface) {
          throw new Error("A plugin can select only its own registered UI replacement.");
        }
        owner.selections.set(surface, id);
        if (
          runtime
            .registrations("replacements")
            .some((entry) => entry.host.signal === owner.abort.signal)
        ) {
          runtime.selectReplacement(
            surface,
            id === null ? null : `${owner.descriptor.pluginId}/${id}`,
          );
        }
      },
    },
  };
}

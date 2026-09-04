import { ContextProvider } from "@lit/context";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import type { MentionsCapability } from "../app/mentions.ts";

export const hiddenScopeUpgradeCapability = {
  state: { phase: "hidden" as const },
  activate: () => undefined,
  request: () => undefined,
  retry: () => undefined,
  cancel: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies ApplicationContext["scopeUpgrade"];

const unavailableMentionsCapability = {
  snapshot: { phase: "unavailable", items: [], dismissing: [], error: null },
  refresh: async () => undefined,
  dismiss: async () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies MentionsCapability;

const emptySidebarAttentionStore = {
  entries: [],
  activate: () => unavailableMentionsCapability,
  dismiss: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies ApplicationContext["sidebarAttention"];

export function createApplicationContextProvider(context: ApplicationContext<RouteId>) {
  const host = document.createElement("div");
  const normalize = (value: ApplicationContext<RouteId>) => {
    if (!value.sidebarAttention) {
      Object.assign(value, { sidebarAttention: emptySidebarAttentionStore });
    }
    return value;
  };
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: normalize(context),
  });
  return Object.assign(host, {
    setContext: (value: ApplicationContext<RouteId>) => provider.setValue(normalize(value)),
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;

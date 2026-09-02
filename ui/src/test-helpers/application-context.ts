import { ContextProvider } from "@lit/context";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";

export const hiddenScopeUpgradeCapability = {
  state: { phase: "hidden" as const },
  activate: () => undefined,
  request: () => undefined,
  retry: () => undefined,
  cancel: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies ApplicationContext["scopeUpgrade"];

const emptySidebarAttentionStore = {
  entries: [],
  activate: () => undefined,
  dismiss: () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined,
} satisfies ApplicationContext["sidebarAttention"];

export function createApplicationContextProvider(context: ApplicationContext<RouteId>) {
  const host = document.createElement("div");
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: context.sidebarAttention
      ? context
      : { ...context, sidebarAttention: emptySidebarAttentionStore },
  });
  return Object.assign(host, {
    setContext: (value: ApplicationContext<RouteId>) => provider.setValue(value),
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;

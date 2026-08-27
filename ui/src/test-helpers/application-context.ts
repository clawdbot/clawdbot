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

export function createApplicationContextProvider(context: ApplicationContext<RouteId>) {
  const host = document.createElement("div");
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: context,
  });
  return Object.assign(host, {
    setContext: (value: ApplicationContext<RouteId>) => provider.setValue(value),
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;

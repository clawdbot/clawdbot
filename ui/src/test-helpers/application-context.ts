import { ContextProvider } from "@lit/context";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";

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

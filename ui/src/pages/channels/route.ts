import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

function loadChannelsRoute(context: ApplicationContext) {
  const primaryRefresh = Promise.all([
    context.channels.refresh(false),
    context.runtimeConfig.ensureLoaded(),
  ]);
  void primaryRefresh.then(
    () => {
      void context.runtimeConfig.ensureSchemaLoaded();
    },
    () => undefined,
  );
}

export const page = definePage({
  ...routePageSpec("channels"),
  loader: (context: ApplicationContext) => loadChannelsRoute(context),
  component: () =>
    import("./channels-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-channels-page></openclaw-channels-page>`,
    })),
});

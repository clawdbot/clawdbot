import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("cloud-workers"),
  loader: (context: ApplicationContext) => context.runtimeConfig.ensureLoaded(),
  component: () =>
    import("./cloud-workers-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-cloud-workers-page></openclaw-cloud-workers-page>`,
    })),
});

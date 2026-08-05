import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("labs"),
  loader: (context: ApplicationContext) => context.runtimeConfig.ensureLoaded(),
  component: () =>
    import("./labs-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-labs-page></openclaw-labs-page>`,
    })),
});

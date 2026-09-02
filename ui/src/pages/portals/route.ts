import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("portals"),
  component: () =>
    import("./portals-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-portals-page></openclaw-portals-page>`,
    })),
});

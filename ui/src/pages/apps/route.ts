import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("apps"),
  component: () =>
    import("./apps-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-apps-page></openclaw-apps-page>`,
    })),
});

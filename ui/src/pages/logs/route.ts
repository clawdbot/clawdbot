import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("logs"),
  component: () =>
    import("./logs-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-logs-page></openclaw-logs-page>`,
    })),
});

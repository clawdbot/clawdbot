import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("activity"),
  component: () =>
    import("./activity-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-activity-page></openclaw-activity-page>`,
    })),
});

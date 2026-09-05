import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("about"),
  component: () =>
    import("./about-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-about-page></openclaw-about-page>`,
    })),
});

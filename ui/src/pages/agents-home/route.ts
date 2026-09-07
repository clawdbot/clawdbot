import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("agents-home"),
  component: () =>
    import("./agents-home-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-agents-home-page></openclaw-agents-home-page>`,
    })),
});

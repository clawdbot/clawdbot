import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("crabdex"),
  component: () =>
    import("./crabdex-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-crabdex-page></openclaw-crabdex-page>`,
    })),
});

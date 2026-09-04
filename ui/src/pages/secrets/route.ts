import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("secrets"),
  component: () =>
    import("./secrets-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-secrets-page></openclaw-secrets-page>`,
    })),
});

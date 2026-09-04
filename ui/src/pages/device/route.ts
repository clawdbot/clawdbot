import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("device"),
  component: () =>
    import("./device-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-device-page></openclaw-device-page>`,
    })),
});

export const permissionsPage = definePage({
  ...routePageSpec("device-permissions"),
  component: () =>
    import("./permissions-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-device-permissions-page></openclaw-device-permissions-page>`,
    })),
});

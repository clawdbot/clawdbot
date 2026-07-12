import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "connection",
  path: "/settings/connection",
  component: () =>
    import("./connection-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-connection-page></openclaw-connection-page>`,
    })),
});

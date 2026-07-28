import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "logs",
  path: "/logs",
  component: () =>
    import("./logs-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-logs-page></openclaw-logs-page>`,
    })),
});

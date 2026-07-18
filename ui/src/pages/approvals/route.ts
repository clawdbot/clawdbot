import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "approvals",
  path: "/settings/approvals",
  component: () =>
    import("./approvals-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-approvals-page></openclaw-approvals-page>`,
    })),
});

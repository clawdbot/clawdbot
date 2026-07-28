import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "lobsterdex",
  path: "/settings/lobsterdex",
  aliases: ["/lobsterdex"],
  component: () =>
    import("./lobsterdex-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-lobsterdex-page></openclaw-lobsterdex-page>`,
    })),
});

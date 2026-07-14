import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "memory-import",
  path: "/settings/memory-import",
  aliases: ["/memory-import"],
  component: () =>
    import("./memory-import-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-memory-import-page></openclaw-memory-import-page>`,
    })),
});

import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "claws",
  path: "/claws",
  component: () =>
    import("./claws-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-claws-page></openclaw-claws-page>`,
    })),
});

import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "about",
  path: "/settings/about",
  component: () =>
    import("./about-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-about-page></openclaw-about-page>`,
    })),
});

import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  id: "labs",
  path: "/settings/labs",
  loader: (context: ApplicationContext) => context.runtimeConfig.ensureLoaded(),
  component: () =>
    import("./labs-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-labs-page></openclaw-labs-page>`,
    })),
});

import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  id: "profile",
  path: "/settings/profile",
  aliases: ["/profile"],
  loader: (context: ApplicationContext) => {
    // Warm the agents list so the hero identity renders without a flash.
    void context.agents.ensureList();
  },
  component: () =>
    import("./profile-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-profile-page></openclaw-profile-page>`,
    })),
});

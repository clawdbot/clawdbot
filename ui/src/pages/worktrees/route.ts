import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "worktrees",
  path: "/worktrees",
  aliases: ["/settings/worktrees"],
  component: () =>
    import("./worktrees-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-worktrees-page></openclaw-worktrees-page>`,
    })),
});

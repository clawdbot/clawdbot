import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";

function agentIdFromLocation(location: RouteLocation): string {
  return new URLSearchParams(location.search).get("agent")?.trim() ?? "";
}

export const page = definePage({
  id: "new-session",
  path: "/new",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    agentIdFromLocation(location),
  loader: (_context: ApplicationContext, { location }) => ({
    agentId: agentIdFromLocation(location),
  }),
  component: () =>
    import("./new-session-page.ts").then(() => ({
      render: (data: unknown) =>
        html`<openclaw-new-session-page .data=${data}></openclaw-new-session-page>`,
    })),
});

import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveSessionAgentFilterId } from "../../lib/sessions/session-options.ts";
import {
  createDreamingState,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
} from "./dreaming.ts";
import type { DreamsRouteData } from "./dreams-page.ts";

async function loadDreamsRoute(context: ApplicationContext): Promise<DreamsRouteData> {
  const gateway = context.gateway;
  const gatewaySnapshot = gateway.snapshot;
  await Promise.all([context.runtimeConfig.ensureLoaded(), context.agents.ensureList()]);
  const sessionKey = gatewaySnapshot.sessionKey;
  const state = createDreamingState({
    client: gatewaySnapshot.client,
    connected: gatewaySnapshot.connected,
    hello: gatewaySnapshot.hello,
    configSnapshot: context.runtimeConfig.state.configSnapshot,
    applySessionKey: sessionKey,
    selectedAgentId: resolveSessionAgentFilterId(
      {
        agentsList: context.agents.state.agentsList,
        sessionKey,
      },
      sessionKey,
    ),
  });
  await Promise.all([
    loadDreamingStatus(state),
    loadDreamDiary(state),
    loadWikiImportInsights(state),
    loadWikiMemoryPalace(state),
  ]);
  return { gateway, gatewaySnapshot, state };
}

export const page = definePage({
  id: "dreams",
  path: "/dreaming",
  aliases: ["/dreams"],
  loader: loadDreamsRoute,
  component: () =>
    import("./dreams-page.ts").then(() => ({
      header: true,
      render: (data: DreamsRouteData | undefined) =>
        html`<openclaw-dreams-page .routeData=${data}></openclaw-dreams-page>`,
    })),
});

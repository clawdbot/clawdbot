import type { ApplicationContext } from "../../app/context.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";

export function pathForCustodianAgentHandoff(
  context: Pick<ApplicationContext, "agents" | "agentSelection" | "basePath" | "gateway">,
  sessionKey: string,
): string {
  return sessionNavigationTarget({
    face: "chat",
    sessionKey,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    basePath: context.basePath,
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  }).href;
}

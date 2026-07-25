import type { ApplicationContext } from "../../app/context.ts";
import { pathForSessionKey } from "../../lib/sessions/navigation.ts";
import { resolveUiConfiguredMainKey } from "../../lib/sessions/session-key.ts";

export function pathForCustodianAgentHandoff(
  context: Pick<ApplicationContext, "agents" | "basePath" | "gateway">,
  sessionKey: string,
): string {
  return pathForSessionKey(
    "chat",
    sessionKey,
    context.basePath,
    undefined,
    resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  );
}

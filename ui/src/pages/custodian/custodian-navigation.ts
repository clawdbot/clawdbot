import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";

/**
 * Route an `open-agent` reply to the destination agent chat. Resolves the
 * target session (refreshing the roster for an explicit agent), then either
 * navigates with a hatch draft or reports that the caller should exit setup.
 * Returns "stale" when the store's request context moved on mid-refresh.
 */
export async function performCustodianAgentHandoff(params: {
  context: ApplicationContext;
  agentId?: string;
  hatchDraft: boolean;
  isCurrent: () => boolean;
}): Promise<"navigated" | "exit-setup" | "stale"> {
  const { context } = params;
  let sessionKey = context.gateway.snapshot.sessionKey?.trim();
  if (params.agentId) {
    const roster = await context.agents.refreshList();
    if (!params.isCurrent()) {
      return "stale";
    }
    sessionKey = buildAgentMainSessionKey({ agentId: params.agentId, mainKey: roster?.mainKey });
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId: params.agentId,
    });
  }
  if (params.hatchDraft && sessionKey) {
    context.navigate("chat", {
      pathname: pathForCustodianAgentHandoff(context, sessionKey),
      search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
    });
    return "navigated";
  }
  return "exit-setup";
}

function pathForCustodianAgentHandoff(
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

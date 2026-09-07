import { html } from "lit";
import type { SessionsUsageResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";

export function renderUsagePageShell(
  context: ApplicationContext,
  result: SessionsUsageResult | null,
  body: unknown,
) {
  const additionalAgentIds =
    result?.sessions
      .map((entry) => entry.agentId)
      .filter((agentId): agentId is string => Boolean(agentId?.trim())) ?? [];
  return html`
    ${renderSettingsPageHeader({
      title: titleForRoute("usage"),
      subtitle: subtitleForRoute("usage"),
      actions: renderAgentScopeControl({
        agents: context.agents.state.agentsList?.agents ?? [],
        additionalAgentIds,
        selection: context.agentSelection,
      }),
    })}
    ${renderSettingsWorkspace(body)}
  `;
}

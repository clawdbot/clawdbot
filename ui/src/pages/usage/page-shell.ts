import { html } from "lit";
import type { SessionsUsageResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
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
    <section class="content-header content-header--page">
      <div>
        <div class="page-title">${titleForRoute("usage")}</div>
      </div>
      ${renderAgentScopeControl({
        agents: context.agents.state.agentsList?.agents ?? [],
        additionalAgentIds,
        selection: context.agentSelection,
      })}
    </section>
    ${renderSettingsWorkspace(body)}
  `;
}

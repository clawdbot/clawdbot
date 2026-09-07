import { html } from "lit";
import { AgentRosterElement } from "../../lib/agents/roster-element.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { renderAgentsHome } from "./view.ts";

export class AgentsHomePage extends AgentRosterElement {
  override render() {
    return this.avatars.withActiveRoutes(() => {
      return renderAgentsHome({
        cards: this.cards(),
        context: this.context,
        connected: this.connected,
        loading: this.roster.loading,
        error: this.roster.error ?? this.roster.subscriptionError,
        onRetry: () => void this.refresh(),
        canCreate: canCallGatewayMethod(
          this.context.gateway.snapshot,
          "openclaw.chat",
          "operator.admin",
        ),
      });
    });
  }
}

export const header = true;
export const render = () => html`<openclaw-agents-home-page></openclaw-agents-home-page>`;

if (!customElements.get("openclaw-agents-home-page")) {
  customElements.define("openclaw-agents-home-page", AgentsHomePage);
}

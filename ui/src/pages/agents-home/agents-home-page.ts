import { TaskStatus } from "@lit/task";
import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { AgentRosterElement } from "../../lib/agents/roster-element.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { renderAgentsHome } from "./view.ts";

export class AgentsHomePage extends AgentRosterElement {
  override render() {
    return this.avatars.withActiveRoutes(() => {
      return renderAgentsHome({
        cards: this.cards(),
        context: this.context,
        connected: this.gateway.connected,
        loading: this.roster.status === TaskStatus.PENDING,
        error:
          this.roster.status === TaskStatus.ERROR
            ? formatUiError(this.roster.error, t("agentsHome.loadFailed"))
            : this.subscriptionError,
        onRetry: () => void this.refresh(),
        canCreate: canCallGatewayMethod(this.gateway.snapshot, "openclaw.chat", "operator.admin"),
      });
    });
  }
}

export const header = true;
export const render = () => html`<openclaw-agents-home-page></openclaw-agents-home-page>`;

if (!customElements.get("openclaw-agents-home-page")) {
  customElements.define("openclaw-agents-home-page", AgentsHomePage);
}

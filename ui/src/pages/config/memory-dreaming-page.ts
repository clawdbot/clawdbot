// Dreams tab host. Agent selection is owned by the parent Memory page so the
// Overview and Dreams tabs always describe the same workspace.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../agents/memory/memory-panel.ts";
import { renderMemoryAgentScope } from "./memory.ts";

class MemoryDreamingSettings extends OpenClawLightDomElement {
  @property() agentId: string | null = null;
  @property({ attribute: false }) agents: readonly AgentSelectOption[] = [];
  @property({ attribute: false }) onAgentChange: (agentId: string | null) => void = () => {};

  override render() {
    return html`
      <div class="settings-page">
        ${renderMemoryAgentScope({
          agentId: this.agentId,
          agents: this.agents,
          onAgentChange: this.onAgentChange,
        })}
      </div>
      ${this.agentId
        ? html`<openclaw-agent-memory-panel .agentId=${this.agentId}></openclaw-agent-memory-panel>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-memory-dreaming")) {
  customElements.define("openclaw-memory-dreaming", MemoryDreamingSettings);
}

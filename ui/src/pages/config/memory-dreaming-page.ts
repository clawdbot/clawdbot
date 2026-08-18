// Dreams tab host. Agent selection is owned by the parent Memory page.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import "../agents/memory/memory-panel.ts";

class MemoryDreamingSettings extends OpenClawLightDomContentsElement {
  @property() agentId: string | null = null;

  override render() {
    return html`
      ${this.agentId
        ? html`<openclaw-agent-memory-panel .agentId=${this.agentId}></openclaw-agent-memory-panel>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-memory-dreaming")) {
  customElements.define("openclaw-memory-dreaming", MemoryDreamingSettings);
}

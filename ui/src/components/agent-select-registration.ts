import { AgentSelect } from "./agent-select.ts";

if (!customElements.get("openclaw-agent-select")) {
  customElements.define("openclaw-agent-select", AgentSelect);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-select": AgentSelect;
  }
}

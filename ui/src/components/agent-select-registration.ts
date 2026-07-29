import { AgentSelect } from "./agent-select.ts";

if (!customElements.get("openclaw-agent-select")) {
  customElements.define("openclaw-agent-select", AgentSelect);
}

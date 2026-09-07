import { MultiSelect } from "./multi-select.ts";

if (!customElements.get("openclaw-multi-select")) {
  customElements.define("openclaw-multi-select", MultiSelect);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-multi-select": MultiSelect;
  }
}

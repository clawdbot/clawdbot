// Public custom-element entrypoint for the Control UI chat pane.
import { ChatPane } from "./chat-pane-render.ts";

if (!customElements.get("openclaw-chat-pane")) {
  customElements.define("openclaw-chat-pane", ChatPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane": ChatPane;
  }
}

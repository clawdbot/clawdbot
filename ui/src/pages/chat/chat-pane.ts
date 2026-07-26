// Public custom-element entrypoint for the Control UI chat pane.
import { ChatPaneRender } from "./chat-pane-render.ts";

class ChatPane extends ChatPaneRender {}

if (!customElements.get("openclaw-chat-pane")) {
  customElements.define("openclaw-chat-pane", ChatPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane": ChatPane;
  }
}

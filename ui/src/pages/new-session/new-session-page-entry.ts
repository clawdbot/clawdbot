import { html } from "lit";
import { NewSessionPage } from "./new-session-page.ts";

if (!customElements.get("openclaw-new-session-page")) {
  customElements.define("openclaw-new-session-page", NewSessionPage);
}

export const render = (data: unknown) =>
  html`<openclaw-new-session-page .data=${data}></openclaw-new-session-page>`;

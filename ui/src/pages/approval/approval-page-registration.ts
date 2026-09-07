import { ApprovalPage } from "./approval-page.ts";

if (!customElements.get("openclaw-approval-page")) {
  customElements.define("openclaw-approval-page", ApprovalPage);
}

import { GitHubLinkHovercardProvider } from "./github-link-hovercard.ts";

if (!customElements.get("openclaw-github-link-hovercard-provider")) {
  customElements.define("openclaw-github-link-hovercard-provider", GitHubLinkHovercardProvider);
}

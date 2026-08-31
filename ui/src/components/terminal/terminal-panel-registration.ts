import { OpenClawTerminalPanel } from "./terminal-panel.ts";

// Guarded define so shared registries can retain this module across reloads.
if (!customElements.get("openclaw-terminal-panel")) {
  customElements.define("openclaw-terminal-panel", OpenClawTerminalPanel);
}

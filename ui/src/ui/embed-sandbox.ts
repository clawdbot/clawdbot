import type { ControlUiEmbedSandboxMode } from "../../../src/gateway/control-ui-contract.js";

export type EmbedSandboxMode = ControlUiEmbedSandboxMode;

export function resolveEmbedSandbox(mode: EmbedSandboxMode | null | undefined): string {
  switch (mode) {
    case "strict":
      return "";
    case "trusted":
      return "allow-scripts allow-same-origin";
    case "scripts":
    default:
      return "allow-scripts";
  }
}

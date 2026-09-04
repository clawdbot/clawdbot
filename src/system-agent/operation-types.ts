// Leaf contract for the parsed OpenClaw operation shape. Kept import-free so
// gateway server types can reference it without pulling the system-agent
// runtime graph (operations-parse -> overview -> config -> gateway) into a
// type-only import cycle.

/** Parsed OpenClaw operation before approval/execution. */
export type SystemAgentOperation =
  | { kind: "none"; message: string }
  | { kind: "overview" }
  | { kind: "doctor" }
  | { kind: "doctor-fix" }
  | { kind: "status" }
  | { kind: "health" }
  | { kind: "config-validate" }
  | { kind: "config-get"; path: string }
  | { kind: "config-schema"; path?: string }
  | { kind: "config-set"; path: string; value: string }
  | {
      kind: "config-set-ref";
      path: string;
      source: "env" | "file" | "exec" | "store";
      id: string;
      provider?: string;
    }
  | { kind: "setup"; workspace?: string; model?: string; agentName?: string }
  | SystemAgentNavigationOperation
  | { kind: "channel-list" }
  | { kind: "channel-info"; channel: string }
  | { kind: "gateway-status" }
  | { kind: "gateway-start" }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "agents" }
  | { kind: "models" }
  | { kind: "plugin-list" }
  | { kind: "plugin-search"; query: string }
  | { kind: "plugin-install"; spec: string }
  | { kind: "plugin-uninstall"; pluginId: string }
  | { kind: "audit" }
  | {
      kind: "create-agent";
      agentId: string;
      workspace?: string;
      model?: string;
      requesterAgentId?: string;
    }
  | { kind: "set-default-model"; model: string; agentId?: string };

/** Interactive actions owned by the host chat, never by delegated model turns. */
export type SystemAgentNavigationOperation =
  | { kind: "model-setup"; workspace?: string }
  | { kind: "model-accounts" }
  | { kind: "channel-setup"; channel: string }
  | { kind: "skills-setup" }
  | { kind: "search-setup" }
  | { kind: "gateway-config-setup" }
  | { kind: "memory-import" }
  | {
      kind: "open-setup";
      target: "guided" | "classic" | "channels" | "search" | "gateway";
      channel?: string;
    }
  | { kind: "open-tui"; agentId?: string; workspace?: string; agentDraft?: "hatch" };

export function isSystemAgentNavigationOperation(
  operation: SystemAgentOperation,
): operation is SystemAgentNavigationOperation {
  switch (operation.kind) {
    case "channel-setup":
    case "skills-setup":
    case "search-setup":
    case "gateway-config-setup":
    case "memory-import":
    case "model-setup":
    case "model-accounts":
    case "open-setup":
    case "open-tui":
      return true;
    default:
      return false;
  }
}

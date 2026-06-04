// Defines shared agent configuration types across runtime schemas.
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
  SandboxSshSettings,
} from "./types.sandbox.js";

/** Agent model selector: a single provider/model ref or primary+fallback chain. */
export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

/** Tool-specific model selector with an optional capability timeout override. */
export type AgentToolModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-tool model fallbacks (provider/model). */
      fallbacks?: string[];
      /** Optional provider request timeout in milliseconds for capabilities that support it. */
      timeoutMs?: number;
    };

export type AgentEmbeddedHarnessConfig = {
  /** Agent runtime id. Omitted uses "openclaw"; "auto" opts into plugin harness auto-selection. */
  runtime?: string;
};

/** Runtime selection policy attached to providers, models, and agent defaults. */
export type AgentRuntimePolicyConfig = {
  /** Agent runtime id. Omitted uses "openclaw"; "auto" opts into plugin harness auto-selection. */
  id?: string;
};

/** Per-agent sandbox policy shared by embedded agents and sandbox backends. */
export type AgentSandboxConfig = {
  /** Sandbox activation mode for this agent. */
  mode?: "off" | "non-main" | "all";
  /** Sandbox runtime backend id. Default: "docker". */
  backend?: string;
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  /** Host workspace root mounted or copied into the sandbox. */
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** SSH-specific sandbox settings. */
  ssh?: SandboxSshSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};

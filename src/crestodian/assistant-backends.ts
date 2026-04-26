import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CrestodianOverview } from "./overview.js";

export const CRESTODIAN_CLAUDE_CLI_MODEL = "claude-opus-4-7";
export const CRESTODIAN_CODEX_MODEL = "gpt-5.5";

export type CrestodianLocalPlannerBackend = {
  kind: "claude-cli" | "codex-app-server" | "codex-cli";
  label: string;
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  buildConfig: (workspaceDir: string) => OpenClawConfig;
};

const CLAUDE_CLI_BACKEND: CrestodianLocalPlannerBackend = {
  kind: "claude-cli",
  label: `claude-cli/${CRESTODIAN_CLAUDE_CLI_MODEL}`,
  runner: "cli",
  provider: "claude-cli",
  model: CRESTODIAN_CLAUDE_CLI_MODEL,
  buildConfig: (workspaceDir) =>
    buildCliPlannerConfig(workspaceDir, `claude-cli/${CRESTODIAN_CLAUDE_CLI_MODEL}`),
};

const CODEX_APP_SERVER_BACKEND: CrestodianLocalPlannerBackend = {
  kind: "codex-app-server",
  label: `openai/${CRESTODIAN_CODEX_MODEL} via codex`,
  runner: "embedded",
  provider: "openai",
  model: CRESTODIAN_CODEX_MODEL,
  buildConfig: buildCodexAppServerPlannerConfig,
};

const CODEX_CLI_BACKEND: CrestodianLocalPlannerBackend = {
  kind: "codex-cli",
  label: `codex-cli/${CRESTODIAN_CODEX_MODEL}`,
  runner: "cli",
  provider: "codex-cli",
  model: CRESTODIAN_CODEX_MODEL,
  buildConfig: (workspaceDir) =>
    buildCliPlannerConfig(workspaceDir, `codex-cli/${CRESTODIAN_CODEX_MODEL}`),
};

export function selectCrestodianLocalPlannerBackends(
  overview: CrestodianOverview,
): CrestodianLocalPlannerBackend[] {
  const backends: CrestodianLocalPlannerBackend[] = [];
  if (overview.tools.claude.found) {
    backends.push(CLAUDE_CLI_BACKEND);
  }
  if (overview.tools.codex.found) {
    backends.push(CODEX_APP_SERVER_BACKEND, CODEX_CLI_BACKEND);
  }
  return backends;
}

function buildCliPlannerConfig(workspaceDir: string, modelRef: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: modelRef },
      },
    },
  };
}

function buildCodexAppServerPlannerConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        agentRuntime: { id: "codex", fallback: "none" },
        model: { primary: `openai/${CRESTODIAN_CODEX_MODEL}` },
      },
    },
    plugins: {
      entries: {
        codex: { enabled: true },
      },
    },
  };
}

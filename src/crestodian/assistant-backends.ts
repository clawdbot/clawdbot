// Crestodian planner backends choose safe local model runners available on this host.
import { randomInt } from "node:crypto";
import {
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
} from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CrestodianOverview } from "./overview.js";

/**
 * Local planner/agent-loop backend selection for Crestodian.
 *
 * Crestodian only offers backends backed by tools present on the host, and the
 * returned backend config is scoped to the workspace being repaired.
 */
export type CrestodianLocalPlannerBackendKind = "claude-cli" | "codex-app-server" | "gemini-cli";

type CrestodianLocalPlannerBackend = {
  kind: CrestodianLocalPlannerBackendKind;
  label: string;
  runner: "cli" | "embedded";
  provider: string;
  model: string;
  buildConfig: (workspaceDir: string) => OpenClawConfig;
};

function splitModelRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

const CLAUDE_CLI_BACKEND: CrestodianLocalPlannerBackend = {
  kind: "claude-cli",
  label: CLAUDE_CLI_DEFAULT_MODEL_REF,
  runner: "cli",
  ...splitModelRef(CLAUDE_CLI_DEFAULT_MODEL_REF),
  buildConfig: (workspaceDir) => buildCliPlannerConfig(workspaceDir, CLAUDE_CLI_DEFAULT_MODEL_REF),
};

const CODEX_APP_SERVER_BACKEND: CrestodianLocalPlannerBackend = {
  kind: "codex-app-server",
  label: `${CODEX_APP_SERVER_DEFAULT_MODEL_REF} via codex`,
  runner: "embedded",
  ...splitModelRef(CODEX_APP_SERVER_DEFAULT_MODEL_REF),
  buildConfig: buildCodexAppServerPlannerConfig,
};

const GEMINI_CLI_BACKEND: CrestodianLocalPlannerBackend = {
  kind: "gemini-cli",
  label: GEMINI_CLI_DEFAULT_MODEL_REF,
  runner: "cli",
  ...splitModelRef(GEMINI_CLI_DEFAULT_MODEL_REF),
  buildConfig: (workspaceDir) => buildCliPlannerConfig(workspaceDir, GEMINI_CLI_DEFAULT_MODEL_REF),
};

/** Select local assistant planner backends available for the current overview. */
export function selectCrestodianLocalPlannerBackends(
  overview: CrestodianOverview,
  deps: {
    randomInt?: (maxExclusive: number) => number;
    preferredKind?: Extract<CrestodianLocalPlannerBackendKind, "claude-cli" | "codex-app-server">;
  } = {},
): CrestodianLocalPlannerBackend[] {
  const backends: CrestodianLocalPlannerBackend[] = [];
  if (overview.tools.claude.found) {
    backends.push(CLAUDE_CLI_BACKEND);
  }
  if (overview.tools.codex.found) {
    backends.push(CODEX_APP_SERVER_BACKEND);
  }
  // Both local runtimes are peers. Randomize their order so repeated fresh
  // setup does not encode a product preference for either provider.
  const shouldSwapPeers = deps.preferredKind
    ? backends[1]?.kind === deps.preferredKind
    : backends.length === 2 && (deps.randomInt ?? randomInt)(2) === 1;
  const first = backends[0];
  const second = backends[1];
  if (shouldSwapPeers && first && second) {
    backends[0] = second;
    backends[1] = first;
  }
  if (overview.tools.gemini.found) {
    backends.push(GEMINI_CLI_BACKEND);
  }
  return backends;
}

/** Minimal run config for a CLI-harness model scoped to one workspace. */
export function buildCliPlannerConfig(workspaceDir: string, modelRef: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: modelRef },
      },
    },
  };
}

/** Run config for the Codex app-server harness (exec must be allowed to spawn it). */
export function buildCodexAppServerPlannerConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: CODEX_APP_SERVER_DEFAULT_MODEL_REF },
      },
    },
    // `enabled` gates plugin activation for this run; do not add a `config`
    // block here — harnesses resolve plugin config from the live global
    // config, so per-run `plugins.entries.*.config` keys are silently ignored.
    // The crestodian tool's direct registration is structural (crestodianTool
    // run param -> resolveCodexDynamicToolDirectNames in the codex plugin).
    plugins: {
      entries: {
        codex: { enabled: true },
      },
    },
    // The Codex app-server harness runs a local process; the ephemeral
    // configless config must allow exec or the harness refuses to start
    // ("not available when tools.exec.mode=deny").
    tools: {
      exec: { mode: "full" },
    },
  };
}

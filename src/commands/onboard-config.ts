/** Shared config mutations used by interactive and non-interactive onboarding. */
import fs from "node:fs";
import path from "node:path";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { setConfigValueAtPath } from "../config/config-paths.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolProfileId } from "../config/types.tools.js";
import { resolveUserPath } from "../utils.js";

/** Default tool profile selected during local onboarding. */
const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

export type OnboardingWorkspaceConflict = {
  currentWorkspaceDir: string;
  requestedWorkspaceDir: string;
};

function hasExistingAgentState(env: NodeJS.ProcessEnv): boolean {
  const stateDir = resolveStateDir(env);
  const agentsDir = path.join(stateDir, "agents");
  try {
    if (fs.readdirSync(agentsDir, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return true;
    }
  }
  return [path.join(stateDir, "agent"), path.join(stateDir, "sessions")].some((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

/** Detects a workspace change that could remap an existing agent fleet. */
export function resolveOnboardingWorkspaceConflict(
  baseConfig: OpenClawConfig,
  requestedWorkspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): OnboardingWorkspaceConflict | undefined {
  const configuredWorkspace = baseConfig.agents?.defaults?.workspace?.trim();
  const currentWorkspaceDir = configuredWorkspace
    ? resolveUserPath(configuredWorkspace, env)
    : resolveDefaultAgentWorkspaceDir(env);
  const normalizedCurrent = path.resolve(currentWorkspaceDir);
  const normalizedRequested = path.resolve(resolveUserPath(requestedWorkspaceDir, env));
  if (normalizedCurrent === normalizedRequested) {
    return undefined;
  }

  const hasRoster = listAgentEntries(baseConfig).length > 0;
  if (!hasRoster && !(configuredWorkspace && hasExistingAgentState(env))) {
    return undefined;
  }
  return {
    currentWorkspaceDir: normalizedCurrent,
    requestedWorkspaceDir: normalizedRequested,
  };
}

/** Applies local gateway/workspace defaults without overwriting explicit user defaults. */
// Deliberately writes no session.dmScope: the schema default "main" (one rolling
// personal-agent session across channels) is the product default. Multi-user DM
// isolation is opt-in; `openclaw security audit` nudges it when traffic warrants.
export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
  options: {
    allowWorkspaceChange?: boolean;
    preserveWorkspace?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): OpenClawConfig {
  const workspaceConflict = resolveOnboardingWorkspaceConflict(
    baseConfig,
    workspaceDir,
    options.env,
  );
  const hasRoster = listAgentEntries(baseConfig).length > 0;
  const shouldUpdateWorkspace =
    !options.preserveWorkspace &&
    (options.allowWorkspaceChange || (!hasRoster && !workspaceConflict));
  return {
    ...baseConfig,
    ...(shouldUpdateWorkspace
      ? {
          agents: {
            ...baseConfig.agents,
            defaults: {
              ...baseConfig.agents?.defaults,
              workspace: workspaceDir,
            },
          },
        }
      : {}),
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
    },
  };
}

/** Marks default agents to skip bootstrap file creation. */
export function applySkipBootstrapConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  setConfigValueAtPath(
    next as Record<string, unknown>,
    ["agents", "defaults", "skipBootstrap"],
    true,
  );
  return next;
}

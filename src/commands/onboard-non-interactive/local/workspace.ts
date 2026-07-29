/**
 * Workspace resolution for local non-interactive onboarding.
 *
 * CLI input wins, then existing config, then the computed default workspace,
 * and the final value is expanded through the normal user-path resolver.
 */
import path from "node:path";
import { isDefaultStateDir, resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveUserPath } from "../../../utils.js";
import type { OnboardOptions } from "../../onboard-types.js";

/** Resolves the workspace directory used by local non-interactive setup. */
export function resolveNonInteractiveWorkspaceDir(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  defaultWorkspaceDir: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const workspaceOverride = env.OPENCLAW_WORKSPACE_DIR?.trim() || undefined;
  const implicitWorkspaceDir = isDefaultStateDir(env)
    ? params.defaultWorkspaceDir
    : path.join(resolveStateDir(env), "workspace");
  const raw = (
    params.opts.workspace ??
    params.baseConfig.agents?.defaults?.workspace ??
    workspaceOverride ??
    implicitWorkspaceDir
  ).trim();
  return resolveUserPath(raw, env);
}

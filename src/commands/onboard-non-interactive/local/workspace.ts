/**
 * Workspace resolution for local non-interactive onboarding.
 *
 * CLI input wins, then existing config, then the computed default workspace,
 * and the final value is expanded through the normal user-path resolver.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveUserPath } from "../../../utils.js";
import type { OnboardOptions } from "../../onboard-types.js";

/** Resolves the workspace directory used by local non-interactive setup. */
export function resolveNonInteractiveWorkspaceDir(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  defaultWorkspaceDir: string;
}) {
  const raw = (
    params.opts.workspace ??
    params.baseConfig.agents?.defaults?.workspace ??
    params.defaultWorkspaceDir
  ).trim();
  return resolveUserPath(raw);
}

import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";

/** Root file tools at the task directory without widening the operator's shell policy. */
export function rootedAgentRunParams(workspaceDir: string, executionRoot?: string) {
  return {
    workspaceDir: executionRoot ?? workspaceDir,
    bootstrapWorkspaceDir: workspaceDir,
    cwd: executionRoot,
    sessionRoot: executionRoot,
    requireWritableSandbox: executionRoot ? true : undefined,
    requireWorkspaceOnly: executionRoot ? true : undefined,
  } satisfies Partial<RunEmbeddedAgentParams>;
}

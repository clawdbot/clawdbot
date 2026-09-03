import path from "node:path";

export function resolveCanonicalCodexForkProjectInstructionPolicy(params: {
  workspaceDir: string;
  cwd: string;
  agentWorkspaceDeveloperInstructions: string;
}) {
  const relativeCwd = path.relative(path.resolve(params.workspaceDir), path.resolve(params.cwd));
  const cwdUsesWorkspaceProjectHierarchy =
    relativeCwd === "" ||
    (relativeCwd !== ".." &&
      !relativeCwd.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeCwd));
  return {
    developerInstructions: params.agentWorkspaceDeveloperInstructions,
    configPatch: cwdUsesWorkspaceProjectHierarchy
      ? ({ project_doc_max_bytes: 0 } as const)
      : undefined,
  };
}

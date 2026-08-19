import { AsyncLocalStorage } from "node:async_hooks";

const canonicalSkillWorkspace = new AsyncLocalStorage<string>();

export function runWithCanonicalSkillWorkspace<T>(
  canonicalWorkspaceDir: string | undefined,
  run: () => T,
): T {
  return canonicalWorkspaceDir ? canonicalSkillWorkspace.run(canonicalWorkspaceDir, run) : run();
}

export function getCanonicalSkillWorkspace(): string | undefined {
  return canonicalSkillWorkspace.getStore();
}

import path from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Physical close retains validation for cheap reopens. Registry lifecycle changes
// revoke it across native and transformed module graphs before a replacement opens.
const validatedPaths = resolveGlobalSingleton<Map<string, string>>(
  Symbol.for("openclaw.agentDatabaseValidatedPaths"),
  () => new Map(),
);

export function getValidatedOpenClawAgentDatabaseOwner(pathname: string): string | undefined {
  return validatedPaths.get(path.resolve(pathname));
}

export function setValidatedOpenClawAgentDatabaseOwner(pathname: string, agentId: string): void {
  validatedPaths.set(path.resolve(pathname), agentId);
}

export function invalidateOpenClawAgentDatabaseValidation(pathname: string): void {
  validatedPaths.delete(path.resolve(pathname));
}

export function invalidateOpenClawAgentDatabaseValidationsForAgent(agentId: string): void {
  for (const [pathname, validatedAgentId] of validatedPaths) {
    if (validatedAgentId === agentId) {
      validatedPaths.delete(pathname);
    }
  }
}

export function clearOpenClawAgentDatabaseValidationCache(): void {
  validatedPaths.clear();
}

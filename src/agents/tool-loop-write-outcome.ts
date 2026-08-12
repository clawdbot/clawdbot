import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { resolveToCwd } from "./sessions/tools/path-utils.js";

export function isWriteNoProgressOutcome(details: Record<string, unknown>): boolean {
  // The built-in no-op result echoes the requested path in display text.
  // Its structured `changed: false` flag is the semantic no-progress contract.
  return details.changed === false;
}

export function hashWriteMutationTarget(
  toolName: string,
  params: unknown,
  cwd?: string,
): string | undefined {
  if (toolName !== "write" || !params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const rawPath = Reflect.get(params, "path");
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return undefined;
  }
  const path = cwd ? resolveToCwd(rawPath, cwd) : rawPath;
  return createHash("sha256").update(stableStringify({ path })).digest("hex");
}

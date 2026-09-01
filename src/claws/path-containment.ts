import { relative } from "node:path";
import { isPathRelativeEscape } from "../infra/path-safety.js";

export function clawContainedRelativePath(root: string, target: string): string | undefined {
  const child = relative(root, target);
  // Claw file actions require a strict descendant, never the root itself.
  return child !== "" && !isPathRelativeEscape(child) ? child : undefined;
}

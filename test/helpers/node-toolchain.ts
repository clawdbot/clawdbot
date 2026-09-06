import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveExecutablePath } from "../../src/infra/executable-path.js";

/** Resolve explicit Node tools instead of substituting the test runner's runtime. */
export function requireNodeTool(command: "node" | "npm"): string {
  const executable = resolveExecutablePath(command);
  if (!executable) {
    throw new Error(`Node tool fixture requires ${command} on PATH.`);
  }
  return path.resolve(executable);
}

/** Keep Node's strip-only parser while callers execute the JavaScript in their own runtime. */
export function stripNodeTypeScriptTypes(source: string): string {
  return execFileSync(
    requireNodeTool("node"),
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      'import { readFileSync } from "node:fs"; import { stripTypeScriptTypes } from "node:module"; process.stdout.write(stripTypeScriptTypes(readFileSync(0, "utf8")));',
    ],
    { encoding: "utf8", input: source },
  );
}

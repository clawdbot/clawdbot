// Copy Assets script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";

type BuildCopyContext = {
  prefix: string;
  projectRoot: string;
  verbose: boolean;
};

export function resolveBuildCopyContext(importMetaUrl: string): BuildCopyContext {
  const filePath = fileURLToPath(importMetaUrl);
  return {
    prefix: `[${path.basename(filePath, path.extname(filePath))}]`,
    projectRoot: path.resolve(path.dirname(filePath), ".."),
    verbose: process.env.OPENCLAW_BUILD_VERBOSE === "1",
  };
}

export function logVerboseCopy(context: BuildCopyContext, message: string): void {
  if (context.verbose) {
    console.log(`${context.prefix} ${message}`);
  }
}

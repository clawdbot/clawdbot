import type { RuntimeEnv } from "../runtime.js";
import {
  applyPersistentOperation,
  createNoExitRuntime,
  type ExecuteOptions,
} from "./operations-execution-helpers.js";
import type { SystemAgentOperation, SystemAgentOperationResult } from "./operations-parse.js";
import { validateSystemAgentPluginInstallSpec } from "./plugin-install-spec.js";

export async function executePluginInstall(
  operation: Extract<SystemAgentOperation, { kind: "plugin-install" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  // Reject an untrusted plugin source before proposing or installing it, not
  // only on the approved apply — a formatted "plan" must never surface an
  // arbitrary npm/url/file spec that bypassed the ClawHub trust boundary.
  const validationError = validateSystemAgentPluginInstallSpec(operation.spec);
  if (validationError) {
    throw new Error(validationError);
  }
  const { runPluginInstallCommand } = await import("../cli/plugins-install-command.js");
  const result = await applyPersistentOperation({
    auditOperation: "plugin.install",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      await ctx.commit(() =>
        runPluginInstallCommand({
          raw: operation.spec,
          opts: {},
          runtime: createNoExitRuntime(ctx.runtime),
          allowInstallPolicyWarningPrompt: false,
          ...(ctx.assertPersistentApply
            ? { beforePersistentApply: ctx.assertPersistentApply }
            : {}),
        }),
      );
      return { summary: `Installed plugin ${operation.spec}`, details: { spec: operation.spec } };
    },
  });
  if (result.applied) {
    runtime.log("Restart the Gateway to apply installed plugin changes.");
  }
  return result;
}

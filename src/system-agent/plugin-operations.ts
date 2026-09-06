import type { PluginsInstallResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { resolvePluginLifecycleGateway } from "../cli/plugins-lifecycle-client.js";
import { resolvePluginInstallSourcePlan } from "../plugins/install-source-plan.js";
import {
  capturePluginRuntimeApplications,
  projectPluginRuntimeFailure,
} from "../plugins/lifecycle.js";
import {
  installManagedPlugin,
  planManagedPluginUninstall,
  uninstallManagedPlugin,
} from "../plugins/management-mutations.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  applyPersistentOperation,
  createNoExitRuntime,
  isPluginBackingDefaultInferenceRoute,
  type ExecuteOptions,
} from "./operations-execution-helpers.js";
import type { SystemAgentOperation, SystemAgentOperationResult } from "./operations-parse.js";
import { validateSystemAgentPluginInstallSpec } from "./plugin-install-spec.js";

async function isPluginUninstallBackingDefaultInferenceRoute(pluginId: string): Promise<boolean> {
  const removal = await planManagedPluginUninstall({ pluginId });
  return await isPluginBackingDefaultInferenceRoute(removal.pluginId, ...removal.pluginIds);
}

export async function executePluginOperation(
  operation: Extract<SystemAgentOperation, { kind: "plugin-install" | "plugin-uninstall" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<SystemAgentOperationResult> {
  if (operation.kind === "plugin-install") {
    // Validate before proposal so an approval cannot widen the trusted-source boundary.
    const validationError = validateSystemAgentPluginInstallSpec(operation.spec);
    if (validationError) {
      throw new Error(validationError);
    }
  } else if (await isPluginUninstallBackingDefaultInferenceRoute(operation.pluginId)) {
    const message = [
      `Uninstalling ${operation.pluginId} could remove the provider behind OpenClaw's own active inference route.`,
      `Removing it has to happen with OpenClaw stopped: run \`openclaw plugins uninstall ${operation.pluginId}\` on the machine running it.`,
    ].join("\n");
    runtime.log(message);
    return { applied: false, message };
  }
  const action = operation.kind === "plugin-install" ? "install" : "uninstall";
  const captured =
    opts.applyPluginRuntime && capturePluginRuntimeApplications(opts.applyPluginRuntime);
  try {
    return await applyPersistentOperation({
      auditOperation: `plugin.${action}`,
      operation,
      runtime,
      opts,
      run: async (ctx) => {
        if (operation.kind === "plugin-install") {
          const plan = resolvePluginInstallSourcePlan({
            raw: operation.spec.trim(),
            mode: "install",
          });
          if (!plan.ok) {
            throw new Error(plan.error);
          }
          if (ctx.assertPersistentApply && !captured) {
            throw new Error("Delegated plugin installation requires the Gateway plugin lifecycle.");
          }
          const gateway = captured ? null : await resolvePluginLifecycleGateway();
          await ctx.commit(async () => {
            const installed = gateway
              ? await gateway<PluginsInstallResult>("plugins.install", plan.request)
              : await installManagedPlugin({
                  request: plan.request,
                  applyRuntime: captured?.applyRuntime,
                  beforePersistentApply: ctx.assertPersistentApply,
                });
            const application =
              "application" in installed
                ? installed.application
                : "runtime" in installed
                  ? installed.runtime
                  : undefined;
            for (const warning of [plan.warning, ...(installed.warnings ?? [])]) {
              if (warning) {
                ctx.runtime.log(warning);
              }
            }
            ctx.runtime.log(
              `Installed plugin ${installed.plugin.id}${
                application
                  ? ` in Gateway generation ${application.generation}`
                  : "; saved for the next Gateway start"
              }.`,
            );
          });
          return {
            summary: `Installed plugin ${operation.spec}`,
            details: { spec: operation.spec },
          };
        }
        // A concurrent config write can retarget the default route after approval.
        // Re-verify before entering the removal's asynchronous preparation.
        if (await isPluginUninstallBackingDefaultInferenceRoute(operation.pluginId)) {
          throw new Error(
            `Uninstall aborted: ${operation.pluginId} now backs the active inference route. Removing it has to happen with OpenClaw stopped: run \`openclaw plugins uninstall ${operation.pluginId}\` on the machine running it.`,
          );
        }
        await ctx.commit(async () => {
          const pluginRuntime = createNoExitRuntime(ctx.runtime);
          if (ctx.deps?.runPluginUninstall) {
            await ctx.deps.runPluginUninstall(
              operation.pluginId,
              pluginRuntime,
              ctx.assertPersistentApply
                ? { beforePersistentApply: ctx.assertPersistentApply }
                : undefined,
            );
          } else if (captured) {
            const removed = await uninstallManagedPlugin({
              pluginId: operation.pluginId,
              applyRuntime: captured.applyRuntime,
              beforePersistentApply: ctx.assertPersistentApply,
            });
            for (const warning of removed.warnings ?? []) {
              pluginRuntime.log(warning);
            }
            pluginRuntime.log(
              `Uninstalled plugin ${removed.pluginId}${
                removed.application
                  ? ` in Gateway generation ${removed.application.generation}`
                  : ""
              }.`,
            );
          } else {
            if (ctx.assertPersistentApply) {
              throw new Error("Delegated plugin removal requires the Gateway plugin lifecycle.");
            }
            const { runPluginUninstallCommand } =
              await import("../cli/plugins-uninstall-command.js");
            await runPluginUninstallCommand(operation.pluginId, {}, pluginRuntime);
          }
        });
        return {
          summary: `Uninstalled plugin ${operation.pluginId}`,
          details: { pluginId: operation.pluginId },
        };
      },
    });
  } catch (error) {
    const failure = projectPluginRuntimeFailure(error, captured?.application);
    if (failure.runtime?.committed) {
      runtime.error(
        `Plugin runtime changes were applied in Gateway generation ${failure.runtime.generation}; ${action} did not complete.`,
      );
    }
    throw error;
  }
}

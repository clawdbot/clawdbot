import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
// Experimental `claws gc` command: removes ClawHub packages left behind by
// removed Claws. Operator-installed packages stay protected because their
// installs persist independently owned package refs.
import { planClawGarbageCollection } from "../claws/gc.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import {
  applyClawHubSkillUninstall,
  planClawHubSkillUninstall,
} from "../skills/lifecycle/clawhub-uninstall.js";
import type { ClawsGcOptions } from "./claws-cli.js";
import { runPluginUninstallCommand } from "./plugins-uninstall-command.js";

export async function runClawsGcCommand(
  opts: ClawsGcOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const plan = await planClawGarbageCollection({});
  if (opts.json) {
    writeRuntimeJson(runtime, plan);
    if (!opts.yes) {
      return;
    }
  } else {
    runtime.log("Experimental: Claws contracts may change while RFC 0016 is under review.");
    runtime.log(`Orphaned plugins: ${plan.plugins.length}`);
    for (const plugin of plan.plugins) {
      runtime.log(
        `  plugin ${plugin.ref} (${plugin.installId})${plugin.version ? ` @${plugin.version}` : ""}`,
      );
    }
    runtime.log(`Orphaned skills: ${plan.skills.length}`);
    for (const skill of plan.skills) {
      runtime.log(`  skill ${skill.ref} (${skill.workspace})`);
    }
  }
  if (!opts.yes) {
    return;
  }
  const errors: string[] = [];
  for (const plugin of plan.plugins) {
    try {
      await runPluginUninstallCommand(
        plugin.installId,
        { force: true, invalidateRuntimeCache: false, clawManaged: true },
        runtime,
      );
    } catch (error) {
      errors.push(
        `plugin ${plugin.ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const skill of plan.skills) {
    try {
      const uninstallPlan = await planClawHubSkillUninstall({
        workspaceDir: skill.workspace,
        slug: skill.ref,
        expectedVersion: skill.version ?? "",
      });
      if (!uninstallPlan.ok) {
        errors.push(`skill ${skill.ref}: ${uninstallPlan.error}`);
        continue;
      }
      const applied = await applyClawHubSkillUninstall(uninstallPlan.plan);
      if (!applied.ok) {
        errors.push(`skill ${skill.ref}: ${applied.error}`);
      }
    } catch (error) {
      errors.push(`skill ${skill.ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) {
    for (const error of errors) {
      runtime.error(error);
    }
    runtime.exit(1);
    return;
  }
  runtime.log("Removed all orphaned Claw packages.");
}

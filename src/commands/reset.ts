/**
 * Reset command implementation.
 *
 * It removes selected config/state/workspace surfaces after confirmation and
 * stops managed gateway services before deleting broader state.
 */
import { cancel, confirm, isCancel } from "@clack/prompts";
import { selectStyled } from "../../packages/terminal-core/src/prompt-select-styled.js";
import {
  stylePromptMessage,
  stylePromptTitle,
} from "../../packages/terminal-core/src/prompt-style.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isNixMode, resolveConfigPath } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveCleanupPlanForDryRun, resolveCleanupPlanForRemoval } from "./cleanup-plan.js";
import {
  listAgentSessionDirs,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

type ResetScope = "config" | "config+creds+sessions" | "full";

/** CLI options accepted by `openclaw reset`. */
type ResetOptions = {
  scope?: ResetScope;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

async function stopGatewayIfRunning(runtime: RuntimeEnv): Promise<boolean> {
  if (isNixMode) {
    // Nix mode owns service lifecycle outside OpenClaw-managed launchd/systemd
    // installs, so reset should not try to stop a service it did not create.
    return true;
  }
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(`Gateway service check failed: ${String(err)}`);
    return false;
  }
  if (!loaded) {
    return true;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    runtime.error(`Gateway stop failed: ${String(err)}`);
    return false;
  }
}

function logBackupRecommendation(runtime: RuntimeEnv) {
  runtime.log(`Recommended first: ${formatCliCommand("openclaw backup create")}`);
}

/** Runs the reset command for config, credential/session, or full state scopes. */
export async function resetCommand(runtime: RuntimeEnv, opts: ResetOptions) {
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error("Non-interactive mode requires --yes.");
    runtime.exit(1);
    return;
  }

  let scope = opts.scope;
  if (!scope) {
    if (!interactive) {
      runtime.error("Non-interactive mode requires --scope.");
      runtime.exit(1);
      return;
    }
    const selection = await selectStyled<ResetScope>({
      message: "Reset scope",
      options: [
        {
          value: "config",
          label: "Config only",
          hint: "openclaw.json",
        },
        {
          value: "config+creds+sessions",
          label: "Config + credentials + sessions",
          hint: "keeps workspace + auth profiles",
        },
        {
          value: "full",
          label: "Full reset",
          hint: "state dir + workspace",
        },
      ],
      initialValue: "config+creds+sessions",
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle("Reset cancelled.") ?? "Reset cancelled.");
      runtime.exit(0);
      return;
    }
    scope = selection;
  }

  if (!["config", "config+creds+sessions", "full"].includes(scope)) {
    runtime.error('Invalid --scope. Expected "config", "config+creds+sessions", or "full".');
    runtime.exit(1);
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage(`Proceed with ${scope} reset?`),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle("Reset cancelled.") ?? "Reset cancelled.");
      runtime.exit(0);
      return;
    }
  }

  const dryRun = Boolean(opts.dryRun);
  if (scope === "config") {
    const configPath = resolveConfigPath();
    await removePath(configPath, runtime, { dryRun, label: configPath });
    return;
  }

  logBackupRecommendation(runtime);
  if (dryRun) {
    runtime.log("[dry-run] stop gateway service");
  } else if (!(await stopGatewayIfRunning(runtime))) {
    runtime.exit(1);
    return;
  }

  const cleanupPlan = dryRun
    ? await resolveCleanupPlanForDryRun()
    : await resolveCleanupPlanForRemoval(runtime);
  if (!cleanupPlan) {
    runtime.exit(1);
    return;
  }
  const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } =
    cleanupPlan;

  if (scope === "config+creds+sessions") {
    await removePath(configPath, runtime, { dryRun, label: configPath });
    await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    const sessionDirs = await listAgentSessionDirs(stateDir).catch((error: unknown) => {
      runtime.error(`Failed to inspect session directories: ${String(error)}`);
      return [];
    });
    // Session stores are per-agent directories under state; enumerate them from
    // disk so reset handles agents that are no longer present in config.
    for (const dir of sessionDirs) {
      await removePath(dir, runtime, { dryRun, label: dir });
    }
    runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
    return;
  }

  if (scope === "full") {
    const stateRemoved = await removeStateAndLinkedPaths(
      { stateDir, configPath, oauthDir, configInsideState, oauthInsideState },
      runtime,
      { dryRun },
    );
    await removeWorkspaceDirs(workspaceDirs, runtime, {
      dryRun,
      removeStateRows: !stateRemoved,
    });
    runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
  }
}

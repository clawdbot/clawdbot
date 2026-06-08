/**
 * Reset command implementation.
 *
 * It removes selected config/state/workspace surfaces after confirmation and
 * stops managed gateway services before deleting broader state.
 */
import path from "node:path";
import { cancel, confirm, isCancel } from "@clack/prompts";
import { selectStyled } from "../../packages/terminal-core/src/prompt-select-styled.js";
import {
  stylePromptMessage,
  stylePromptTitle,
} from "../../packages/terminal-core/src/prompt-style.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isNixMode } from "../config/config.js";
import { clearExistingSqliteSessionStore } from "../config/sessions/store-sqlite.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveCleanupPlanFromDisk } from "./cleanup-plan.js";
import {
  listAgentSessionDirs,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceAttestationPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

export type ResetScope = "config" | "config+creds+sessions" | "full";

/** CLI options accepted by `openclaw reset`. */
export type ResetOptions = {
  scope?: ResetScope;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

async function stopGatewayIfRunning(runtime: RuntimeEnv) {
  if (isNixMode) {
    // Nix mode owns service lifecycle outside OpenClaw-managed launchd/systemd
    // installs, so reset should not try to stop a service it did not create.
    return;
  }
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(`Gateway service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) {
    return;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(`Gateway stop failed: ${String(err)}`);
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
  const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } =
    resolveCleanupPlanFromDisk();

  if (scope !== "config") {
    logBackupRecommendation(runtime);
    if (dryRun) {
      runtime.log("[dry-run] stop gateway service");
    } else {
      await stopGatewayIfRunning(runtime);
    }
  }

  if (scope === "config") {
    await removePath(configPath, runtime, { dryRun, label: configPath });
    return;
  }

  if (scope === "config+creds+sessions") {
    await removePath(configPath, runtime, { dryRun, label: configPath });
    await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    const sessionDirs = await listAgentSessionDirs(stateDir);
    // Session stores are per-agent directories under state; enumerate them from
    // disk so reset handles agents that are no longer present in config.
    for (const dir of sessionDirs) {
      if (!dryRun) {
        clearExistingSqliteSessionStore(path.join(dir, "sessions.json"), { compact: true });
      }
      await removePath(dir, runtime, { dryRun, label: dir });
    }
    runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
    return;
  }

  if (scope === "full") {
    await removeStateAndLinkedPaths(
      { stateDir, configPath, oauthDir, configInsideState, oauthInsideState },
      runtime,
      { dryRun },
    );
    await removeWorkspaceDirs(workspaceDirs, runtime, { dryRun });
    // Workspace attestations live beside workspace dirs and can outlive the
    // workspace itself, so full reset cleans both surfaces.
    await removeWorkspaceAttestationPaths(workspaceDirs, runtime, { dryRun });
    runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
  }
}

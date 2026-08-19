// Implements `openclaw uninstall`.
// Handles interactive scope selection, service removal, state/workspace cleanup, and macOS app cleanup.

import path from "node:path";
import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
import { styleSelectParams } from "../../packages/terminal-core/src/prompt-select-styled-params.js";
import {
  stylePromptMessage,
  stylePromptTitle,
} from "../../packages/terminal-core/src/prompt-style.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isNixMode } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveHomeDir } from "../utils.js";
import { resolveCleanupPlanForDryRun, resolveCleanupPlanForRemoval } from "./cleanup-plan.js";
import { removePath, removeStateAndLinkedPaths, removeWorkspaceDirs } from "./cleanup-utils.js";

type UninstallScope = "service" | "state" | "workspace" | "app";

type UninstallOptions = {
  service?: boolean;
  state?: boolean;
  workspace?: boolean;
  app?: boolean;
  all?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

const multiselectStyled = <T>(params: Parameters<typeof multiselect<T>>[0]) =>
  multiselect(styleSelectParams(params));

function buildScopeSelection(opts: UninstallOptions): {
  scopes: Set<UninstallScope>;
  hadExplicit: boolean;
} {
  const hadExplicit = Boolean(opts.all || opts.service || opts.state || opts.workspace || opts.app);
  const scopes = new Set<UninstallScope>();
  if (opts.all || opts.service) {
    scopes.add("service");
  }
  if (opts.all || opts.state) {
    scopes.add("state");
  }
  if (opts.all || opts.workspace) {
    scopes.add("workspace");
  }
  if (opts.all || opts.app) {
    scopes.add("app");
  }
  return { scopes, hadExplicit };
}

async function stopAndUninstallService(runtime: RuntimeEnv): Promise<boolean> {
  if (isNixMode) {
    // Nix owns service lifecycle in Nix mode; uninstalling via launchd/systemd would fight the profile.
    runtime.error(
      `Nix mode detected; service uninstall is disabled. Manage the service through your Nix profile instead, then run ${formatCliCommand("openclaw status")} to verify.`,
    );
    return false;
  }
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(
      `Gateway service check failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for service diagnostics.`,
    );
    return false;
  }
  if (!loaded) {
    runtime.log(`Gateway service ${service.notLoadedText}.`);
  }
  let stopped = true;
  if (loaded) {
    try {
      await service.stop({ env: process.env, stdout: process.stdout });
    } catch (err) {
      stopped = false;
      runtime.error(
        `Gateway stop failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} before retrying uninstall.`,
      );
    }
  }
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(
      `Gateway uninstall failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for the service state.`,
    );
    return false;
  }
  return stopped;
}

async function removeMacApp(runtime: RuntimeEnv, dryRun?: boolean): Promise<boolean> {
  if (process.platform !== "darwin") {
    runtime.log("macOS app cleanup is not applicable on this platform.");
    return true;
  }
  const result = await removePath("/Applications/OpenClaw.app", runtime, {
    dryRun,
    label: "/Applications/OpenClaw.app",
  });
  return result.ok;
}

function logBackupRecommendation(runtime: RuntimeEnv) {
  runtime.log(`Recommended first: ${formatCliCommand("openclaw backup create")}`);
}

/** Runs the uninstall flow for selected service/state/workspace/app scopes. */
export async function uninstallCommand(runtime: RuntimeEnv, opts: UninstallOptions) {
  const { scopes, hadExplicit } = buildScopeSelection(opts);
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error(
      `Non-interactive uninstall requires --yes. Preview first with ${formatCliCommand("openclaw uninstall --dry-run --all")}.`,
    );
    runtime.exit(1);
    return;
  }

  if (!hadExplicit) {
    if (!interactive) {
      runtime.error(
        `Non-interactive uninstall requires explicit scopes. Use --all, or choose scopes such as --service --state.`,
      );
      runtime.exit(1);
      return;
    }
    const selection = await multiselectStyled<UninstallScope>({
      message: "Uninstall which components?",
      options: [
        {
          value: "service",
          label: "Gateway service",
          hint: "launchd / systemd / schtasks",
        },
        { value: "state", label: "State + config", hint: "~/.openclaw" },
        { value: "workspace", label: "Workspace", hint: "agent files" },
        {
          value: "app",
          label: "macOS app",
          hint: "/Applications/OpenClaw.app",
        },
      ],
      initialValues: ["service", "state", "workspace"],
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
      runtime.exit(0);
      return;
    }
    for (const value of selection) {
      scopes.add(value);
    }
  }

  if (scopes.size === 0) {
    runtime.log("Nothing selected.");
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage("Proceed with uninstall?"),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
      runtime.exit(0);
      return;
    }
  }

  const dryRun = Boolean(opts.dryRun);
  let stateRemoved = false;
  let workspaceBlocked = false;
  let failed = false;
  let serviceSafe = true;
  const removesLocalData = scopes.has("state") || scopes.has("workspace");

  if (removesLocalData) {
    logBackupRecommendation(runtime);
  }

  if (scopes.has("service")) {
    if (dryRun) {
      runtime.log("[dry-run] remove gateway service");
    } else if (!(await stopAndUninstallService(runtime))) {
      // Service removal may prevent relaunch even when runtime termination is
      // uncertain; preserve mutable user data until teardown can be verified.
      serviceSafe = false;
      failed = true;
    }
  }

  let cleanupPlan;
  if (removesLocalData && serviceSafe) {
    try {
      cleanupPlan = dryRun
        ? await resolveCleanupPlanForDryRun()
        : await resolveCleanupPlanForRemoval(runtime);
    } catch (error) {
      runtime.error(`Failed to prepare local data cleanup: ${formatErrorMessage(error)}`);
    }
    if (!cleanupPlan) {
      failed = true;
    }
  } else if (removesLocalData) {
    runtime.error("State and workspace cleanup blocked because gateway service teardown failed.");
  }

  if (scopes.has("state") && cleanupPlan) {
    const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } =
      cleanupPlan;
    if (!scopes.has("workspace")) {
      try {
        const legacyFailures = await removeWorkspaceDirs(workspaceDirs, runtime, {
          dryRun,
          preserveWorkspace: true,
        });
        if (legacyFailures.length > 0) {
          runtime.error(`Retired workspace state cleanup incomplete: ${legacyFailures.join(", ")}`);
          failed = true;
        }
      } catch (error) {
        runtime.error(`Retired workspace state cleanup failed: ${formatErrorMessage(error)}`);
        failed = true;
      }
    }
    // Preserve workspaces when state-only uninstall is requested; workspace scope removes them explicitly.
    try {
      stateRemoved = await removeStateAndLinkedPaths(
        { stateDir, configPath, oauthDir, configInsideState, oauthInsideState },
        runtime,
        { dryRun, preservePaths: scopes.has("workspace") ? [] : workspaceDirs },
      );
    } catch (error) {
      runtime.error(`State cleanup failed: ${formatErrorMessage(error)}`);
      workspaceBlocked = true;
    }
    failed ||= !stateRemoved;
  }

  if (scopes.has("workspace") && cleanupPlan && workspaceBlocked) {
    runtime.error("Workspace cleanup blocked because state cleanup could not safely complete.");
  } else if (scopes.has("workspace") && cleanupPlan) {
    try {
      const workspaceFailures = await removeWorkspaceDirs(cleanupPlan.workspaceDirs, runtime, {
        dryRun,
        removeStateRows: !scopes.has("state") || !stateRemoved,
      });
      if (workspaceFailures.length > 0) {
        runtime.error(`Workspace cleanup incomplete: ${workspaceFailures.join(", ")}`);
        failed = true;
      }
    } catch (error) {
      runtime.error(`Workspace cleanup failed: ${formatErrorMessage(error)}`);
      failed = true;
    }
  }

  if (scopes.has("app")) {
    try {
      const appRemoved = await removeMacApp(runtime, dryRun);
      if (!appRemoved) {
        failed = true;
      }
    } catch (error) {
      runtime.error(`App cleanup failed: ${formatErrorMessage(error)}`);
      failed = true;
    }
  }

  if (!failed) {
    runtime.log("CLI still installed. Remove via npm/pnpm if desired.");
  }

  if (scopes.has("state") && !scopes.has("workspace") && cleanupPlan) {
    const home = resolveHomeDir();
    if (home && cleanupPlan.workspaceDirs.some((dir) => dir.startsWith(path.resolve(home)))) {
      runtime.log("Tip: workspaces were preserved. Re-run with --workspace to remove them.");
    }
  }
  if (failed) {
    runtime.exit(1);
  }
}

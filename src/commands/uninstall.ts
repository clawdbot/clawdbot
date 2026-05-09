import path from "node:path";
import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
import { formatCliCommand } from "../cli/command-format.js";
import { isNixMode } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveHomeDir } from "../utils.js";
import { resolveCleanupPlanFromDisk } from "./cleanup-plan.js";
import { removePath, removeStateAndLinkedPaths, removeWorkspaceDirs } from "./cleanup-utils.js";

type UninstallScope = "service" | "state" | "workspace" | "app";

export type UninstallOptions = {
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
  multiselect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

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
    runtime.error(
      `Nix mode detected; service uninstall is disabled. Manage the service through your Nix profile instead, then run ${formatCliCommand("openclaw status")} to verify.`,
    );
    return false;
  }
  const service = resolveGatewayService();
  let loaded = false;
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
    return true;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(
      `Gateway stop failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} before retrying uninstall.`,
    );
  }
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    runtime.error(
      `Gateway uninstall failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for the service state.`,
    );
    return false;
  }
}

async function removeMacApp(runtime: RuntimeEnv, dryRun?: boolean) {
  if (process.platform !== "darwin") {
    return;
  }
  await removePath("/Applications/OpenClaw.app", runtime, {
    dryRun,
    label: "/Applications/OpenClaw.app",
  });
}

function logBackupRecommendation(runtime: RuntimeEnv) {
  runtime.log(`Recommended first: ${formatCliCommand("openclaw backup create")}`);
}

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
  const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } =
    resolveCleanupPlanFromDisk();

  if (scopes.has("state") || scopes.has("workspace")) {
    logBackupRecommendation(runtime);
  }

  if (scopes.has("service")) {
    if (dryRun) {
      runtime.log("[dry-run] remove gateway service");
    } else {
      await stopAndUninstallService(runtime);
    }
  }

  if (scopes.has("state")) {
    await removeStateAndLinkedPaths(
      { stateDir, configPath, oauthDir, configInsideState, oauthInsideState },
      runtime,
      { dryRun },
    );
  }

  if (scopes.has("workspace")) {
    await removeWorkspaceDirs(workspaceDirs, runtime, { dryRun });
  }

  if (scopes.has("app")) {
    await removeMacApp(runtime, dryRun);
  }

  runtime.log("CLI still installed. Remove via npm/pnpm if desired.");

  if (scopes.has("state") && !scopes.has("workspace")) {
    const home = resolveHomeDir();
    if (home && workspaceDirs.some((dir) => dir.startsWith(path.resolve(home)))) {
      runtime.log("Tip: workspaces were preserved. Re-run with --workspace to remove them.");
    }
  }
}

import path from "node:path";
import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";

import {
  isNixMode,
  loadConfig,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveHomeDir } from "../utils.js";
import { collectWorkspaceDirs, isPathWithin, removePath } from "./cleanup-utils.js";

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
  if (opts.all || opts.service) scopes.add("service");
  if (opts.all || opts.state) scopes.add("state");
  if (opts.all || opts.workspace) scopes.add("workspace");
  if (opts.all || opts.app) scopes.add("app");
  return { scopes, hadExplicit };
}

async function stopAndUninstallService(runtime: RuntimeEnv): Promise<boolean> {
  if (isNixMode) {
    runtime.error("Nix mode detected; daemon uninstall is disabled.");
    return false;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(`Gateway service check failed: ${String(err)}`);
    return false;
  }
  if (!loaded) {
    runtime.log(`Gateway service ${service.notLoadedText}.`);
    return true;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(`Gateway stop failed: ${String(err)}`);
  }
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
    return true;
  } catch (err) {
    runtime.error(`Gateway uninstall failed: ${String(err)}`);
    return false;
  }
}

async function removeMacApp(runtime: RuntimeEnv, dryRun?: boolean) {
  if (process.platform !== "darwin") return;
  await removePath("/Applications/Clawdbot.app", runtime, {
    dryRun,
    label: "/Applications/Clawdbot.app",
  });
}

export async function uninstallCommand(runtime: RuntimeEnv, opts: UninstallOptions) {
  const { scopes, hadExplicit } = buildScopeSelection(opts);
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error("Non-interactive mode requires --yes.");
    runtime.exit(1);
    return;
  }

  if (!hadExplicit) {
    if (!interactive) {
      runtime.error("Non-interactive mode requires explicit scopes (use --all).");
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
        { value: "state", label: "State + config", hint: "~/.clawdbot" },
        { value: "workspace", label: "Workspace", hint: "agent files" },
        {
          value: "app",
          label: "macOS app",
          hint: "/Applications/Clawdbot.app",
        },
      ],
      initialValues: ["service", "state", "workspace"],
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle("Uninstall cancelled.") ?? "Uninstall cancelled.");
      runtime.exit(0);
      return;
    }
    for (const value of selection) scopes.add(value);
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
  const cfg = loadConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const configInsideState = isPathWithin(configPath, stateDir);
  const oauthInsideState = isPathWithin(oauthDir, stateDir);
  const workspaceDirs = collectWorkspaceDirs(cfg);

  if (scopes.has("service")) {
    if (dryRun) {
      runtime.log("[dry-run] remove gateway service");
    } else {
      await stopAndUninstallService(runtime);
    }
  }

  if (scopes.has("state")) {
    await removePath(stateDir, runtime, { dryRun, label: stateDir });
    if (!configInsideState) {
      await removePath(configPath, runtime, { dryRun, label: configPath });
    }
    if (!oauthInsideState) {
      await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    }
  }

  if (scopes.has("workspace")) {
    for (const workspace of workspaceDirs) {
      await removePath(workspace, runtime, { dryRun, label: workspace });
    }
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

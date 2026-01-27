import { cancel, confirm, isCancel, select } from "@clack/prompts";

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
import { formatCliCommand } from "../cli/command-format.js";
import {
  collectWorkspaceDirs,
  isPathWithin,
  listAgentSessionDirs,
  removePath,
} from "./cleanup-utils.js";

export type ResetScope = "config" | "config+creds+sessions" | "full";

export type ResetOptions = {
  scope?: ResetScope;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
};

const selectStyled = <T>(params: Parameters<typeof select<T>>[0]) =>
  select({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

async function stopGatewayIfRunning(runtime: RuntimeEnv) {
  if (isNixMode) return;
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(`Gateway service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) return;
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (err) {
    runtime.error(`Gateway stop failed: ${String(err)}`);
  }
}

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
          hint: "moltbot.json",
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
  const cfg = loadConfig();
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const configInsideState = isPathWithin(configPath, stateDir);
  const oauthInsideState = isPathWithin(oauthDir, stateDir);
  const workspaceDirs = collectWorkspaceDirs(cfg);

  if (scope !== "config") {
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
    for (const dir of sessionDirs) {
      await removePath(dir, runtime, { dryRun, label: dir });
    }
    runtime.log(`Next: ${formatCliCommand("moltbot onboard --install-daemon")}`);
    return;
  }

  if (scope === "full") {
    await removePath(stateDir, runtime, { dryRun, label: stateDir });
    if (!configInsideState) {
      await removePath(configPath, runtime, { dryRun, label: configPath });
    }
    if (!oauthInsideState) {
      await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    }
    for (const workspace of workspaceDirs) {
      await removePath(workspace, runtime, { dryRun, label: workspace });
    }
    runtime.log(`Next: ${formatCliCommand("moltbot onboard --install-daemon")}`);
    return;
  }
}

import { homedir } from "node:os";
import type { Command } from "commander";
import * as clack from "@clack/prompts";

import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { danger, setVerbose } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatDocsLink } from "../terminal/links.js";
import { shortenHomePath } from "../utils.js";
import {
  isRcloneInstalled,
  ensureRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  resolveSyncConfig,
  runBisync,
  runSync,
  checkRemote,
  listRemote,
  authorizeRclone,
  writeRcloneConfig,
  generateRcloneConfig,
  type RcloneSyncResult,
} from "../infra/rclone.js";
import type { WorkspaceSyncProvider } from "../config/types.workspace.js";
import type { MoltbotConfig } from "../config/types.clawdbot.js";

type WorkspaceSyncOptions = {
  agent?: string;
  resync?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  direction?: "pull" | "push";
};

type WorkspaceStatusOptions = {
  agent?: string;
  verbose?: boolean;
};

type WorkspaceAuthorizeOptions = {
  provider?: string;
  appKey?: string;
  appSecret?: string;
};

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) return trimmed;
  return resolveDefaultAgentId(cfg);
}

export function registerWorkspaceCli(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Workspace management and cloud sync")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/gateway/workspace-sync",
          "docs.molt.bot/gateway/workspace-sync",
        )}\n`,
    )
    .action(() => {
      workspace.outputHelp();
      defaultRuntime.error(
        danger(`Missing subcommand. Try: "${formatCliCommand("moltbot workspace setup")}"`),
      );
      defaultRuntime.exit(1);
    });

  // moltbot workspace sync
  workspace
    .command("sync")
    .description("Sync workspace with cloud storage")
    .option("--agent <id>", "Agent ID (default: main)")
    .option("--resync", "Force resync (required for first sync)")
    .option("--dry-run", "Preview changes without syncing")
    .option("--direction <dir>", "One-way sync: pull or push")
    .option("-v, --verbose", "Verbose output")
    .action(async (opts: WorkspaceSyncOptions) => {
      try {
        if (opts.verbose) setVerbose(true);

        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const stateDir = resolveStateDir(process.env, homedir);
        const syncConfig = cfg.workspace?.sync;

        const rich = isRich();

        if (!syncConfig?.provider || syncConfig.provider === "off") {
          defaultRuntime.error(colorize(rich, theme.error, "Workspace sync not configured."));
          defaultRuntime.error("");
          defaultRuntime.error(`Run: ${formatCliCommand("moltbot workspace setup")}`);
          defaultRuntime.error(`Docs: ${formatDocsLink("/gateway/workspace-sync")}`);
          defaultRuntime.exit(1);
          return;
        }

        // Check rclone
        const installed = await isRcloneInstalled();
        if (!installed) {
          defaultRuntime.error(colorize(rich, theme.error, "rclone not installed."));
          defaultRuntime.error("");
          defaultRuntime.error(`Run: ${formatCliCommand("moltbot workspace setup")}`);
          defaultRuntime.exit(1);
          return;
        }

        const resolved = resolveSyncConfig(syncConfig, workspaceDir, stateDir);

        // Auto-generate rclone config from moltbot.json if credentials present
        ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

        // Check config
        if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
          console.error(
            colorize(
              rich,
              theme.error,
              `rclone not configured for remote "${resolved.remoteName}".`,
            ),
          );
          console.error("");
          console.error("Run: moltbot workspace authorize");
          console.error(`Or manually configure: ${shortenHomePath(resolved.configPath)}`);
          defaultRuntime.exit(1);
        }

        console.log(
          colorize(rich, theme.info, `Syncing ${resolved.remoteName}:${resolved.remotePath}`),
        );
        console.log(colorize(rich, theme.muted, `Local: ${shortenHomePath(resolved.localPath)}`));

        let result: RcloneSyncResult;

        if (opts.direction) {
          // One-way sync
          result = await runSync({
            configPath: resolved.configPath,
            remoteName: resolved.remoteName,
            remotePath: resolved.remotePath,
            localPath: resolved.localPath,
            direction: opts.direction,
            exclude: resolved.exclude,
            dryRun: opts.dryRun,
            verbose: opts.verbose,
          });
        } else {
          // Bidirectional sync
          result = await runBisync({
            configPath: resolved.configPath,
            remoteName: resolved.remoteName,
            remotePath: resolved.remotePath,
            localPath: resolved.localPath,
            conflictResolve: resolved.conflictResolve,
            exclude: resolved.exclude,
            copySymlinks: resolved.copySymlinks,
            resync: opts.resync,
            dryRun: opts.dryRun,
            verbose: opts.verbose,
          });
        }

        if (result.ok) {
          defaultRuntime.log(colorize(rich, theme.success, "✓ Sync completed"));
          if (result.filesTransferred) {
            defaultRuntime.log(
              colorize(rich, theme.muted, `Files transferred: ${result.filesTransferred}`),
            );
          }
        } else {
          defaultRuntime.error(colorize(rich, theme.error, `✗ Sync failed: ${result.error}`));
          if (result.error?.includes("--resync")) {
            defaultRuntime.error("");
            defaultRuntime.error(
              `First sync requires --resync: ${formatCliCommand("moltbot workspace sync --resync")}`,
            );
          }
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
        defaultRuntime.exit(1);
      }
    });

  // moltbot workspace status
  workspace
    .command("status")
    .description("Show workspace sync status")
    .option("--agent <id>", "Agent ID (default: main)")
    .option("-v, --verbose", "Verbose output")
    .action(async (opts: WorkspaceStatusOptions) => {
      if (opts.verbose) setVerbose(true);

      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const stateDir = resolveStateDir(process.env, homedir);
      const syncConfig = cfg.workspace?.sync;

      const rich = isRich();

      console.log(colorize(rich, theme.heading, "Workspace Sync Status"));
      console.log("");

      // Check config
      if (!syncConfig?.provider || syncConfig.provider === "off") {
        console.log(colorize(rich, theme.muted, "Provider: not configured"));
        console.log("");
        console.log(`Configure in ~/.clawdbot/moltbot.json`);
        console.log(`Docs: ${formatDocsLink("/gateway/workspace-sync")}`);
        return;
      }

      const resolved = resolveSyncConfig(syncConfig, workspaceDir, stateDir);

      console.log(`Provider: ${colorize(rich, theme.info, syncConfig.provider)}`);
      console.log(`Remote: ${resolved.remoteName}:${resolved.remotePath}`);
      console.log(`Local: ${shortenHomePath(resolved.localPath)}`);
      console.log(`Config: ${shortenHomePath(resolved.configPath)}`);
      console.log("");

      // Check rclone
      const installed = await isRcloneInstalled();
      if (!installed) {
        console.log(colorize(rich, theme.error, "✗ rclone not installed"));
        return;
      }
      console.log(colorize(rich, theme.success, "✓ rclone installed"));

      // Auto-generate rclone config from moltbot.json if credentials present
      ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

      // Check config
      const configured = isRcloneConfigured(resolved.configPath, resolved.remoteName);
      if (!configured) {
        console.log(colorize(rich, theme.error, "✗ rclone not configured"));
        console.log("");
        console.log("Run: moltbot workspace authorize");
        console.log("Or add dropbox.token to workspace.sync config");
        return;
      }
      console.log(colorize(rich, theme.success, "✓ rclone configured"));

      // Check connection
      const check = await checkRemote({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
      });
      if (!check.ok) {
        console.log(colorize(rich, theme.error, `✗ Connection failed: ${check.error}`));
        return;
      }
      console.log(colorize(rich, theme.success, "✓ Remote connected"));

      // List remote files
      const list = await listRemote({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
      });
      if (list.ok) {
        console.log("");
        console.log(`Remote files: ${list.files.length}`);
        if (opts.verbose && list.files.length > 0) {
          for (const file of list.files.slice(0, 10)) {
            console.log(colorize(rich, theme.muted, `  ${file}`));
          }
          if (list.files.length > 10) {
            console.log(colorize(rich, theme.muted, `  ... and ${list.files.length - 10} more`));
          }
        }
      }

      // Show auto-sync settings
      console.log("");
      console.log("Auto-sync:");
      console.log(`  On session start: ${resolved.onSessionStart ? "yes" : "no"}`);
      console.log(`  On session end: ${resolved.onSessionEnd ? "yes" : "no"}`);
      if (resolved.interval > 0) {
        console.log(`  Background interval: ${resolved.interval}s (pure rclone, zero LLM cost)`);
      } else {
        console.log(`  Background interval: disabled`);
      }
    });

  // moltbot workspace setup - interactive wizard
  workspace
    .command("setup")
    .description("Interactive setup wizard for cloud sync")
    .action(async () => {
      const rich = isRich();

      clack.intro(colorize(rich, theme.heading, "Workspace Cloud Sync Setup"));

      // Step 1: Check/install rclone
      const rcloneInstalled = await isRcloneInstalled();
      if (!rcloneInstalled) {
        // Offer to install
        const installed = await ensureRcloneInstalled(async (message, defaultValue) => {
          const result = await clack.confirm({ message, initialValue: defaultValue });
          return !clack.isCancel(result) && result;
        });
        if (!installed) {
          clack.note(
            "Install rclone manually:\n\n" +
              "  macOS:   brew install rclone\n" +
              "  Linux:   curl -s https://rclone.org/install.sh | sudo bash\n" +
              "  Docker:  Add to Dockerfile: RUN curl -s https://rclone.org/install.sh | bash",
            "Installation required",
          );
          clack.outro("Install rclone and run this command again.");
          defaultRuntime.exit(1);
          return;
        }
      }
      clack.log.success("rclone is installed");

      // Step 2: Select provider
      const provider = (await clack.select({
        message: "Select cloud provider",
        options: [
          { value: "dropbox", label: "Dropbox", hint: "Recommended - easy setup" },
          {
            value: "gdrive",
            label: "Google Drive",
            hint: "Requires service account for scoped access",
          },
          { value: "onedrive", label: "OneDrive", hint: "Microsoft 365" },
          { value: "s3", label: "S3 / R2 / Minio", hint: "Access key authentication" },
        ],
      })) as WorkspaceSyncProvider;

      if (clack.isCancel(provider)) {
        clack.cancel("Setup cancelled.");
        defaultRuntime.exit(0);
        return;
      }

      // Step 3: Remote folder name
      const remotePath = (await clack.text({
        message: "Remote folder name",
        placeholder: "moltbot-share",
        initialValue: "moltbot-share",
        validate: (value) => {
          if (!value.trim()) return "Folder name is required";
          if (value.includes("/")) return "Use a simple folder name, not a path";
          return undefined;
        },
      })) as string;

      if (clack.isCancel(remotePath)) {
        clack.cancel("Setup cancelled.");
        defaultRuntime.exit(0);
        return;
      }

      // Step 4: Dropbox-specific: app folder option
      let useAppFolder = false;
      let appKey: string | undefined;
      let appSecret: string | undefined;

      if (provider === "dropbox") {
        const accessType = (await clack.select({
          message: "Dropbox access type",
          options: [
            {
              value: "full",
              label: "Full Dropbox",
              hint: "Access entire Dropbox (simpler setup)",
            },
            {
              value: "app",
              label: "App Folder only",
              hint: "Restricted to Apps/<app-name>/ (more secure)",
            },
          ],
        })) as "full" | "app";

        if (clack.isCancel(accessType)) {
          clack.cancel("Setup cancelled.");
          defaultRuntime.exit(0);
          return;
        }

        useAppFolder = accessType === "app";

        if (useAppFolder) {
          clack.note(
            "1. Go to https://www.dropbox.com/developers/apps\n" +
              "2. Click 'Create app'\n" +
              "3. Choose 'Scoped access' → 'App folder'\n" +
              "4. Name it (e.g., 'moltbot-sync')\n" +
              "5. In Permissions tab, enable:\n" +
              "   - files.metadata.read/write\n" +
              "   - files.content.read/write\n" +
              "6. Copy the App key and App secret from Settings",
            "Create Dropbox App",
          );

          appKey = (await clack.text({
            message: "Dropbox App key",
            placeholder: "your-app-key",
          })) as string;

          if (clack.isCancel(appKey)) {
            clack.cancel("Setup cancelled.");
            defaultRuntime.exit(0);
            return;
          }

          appSecret = (await clack.text({
            message: "Dropbox App secret",
            placeholder: "your-app-secret",
          })) as string;

          if (clack.isCancel(appSecret)) {
            clack.cancel("Setup cancelled.");
            defaultRuntime.exit(0);
            return;
          }
        }
      }

      // Step 5: Background sync interval
      const intervalChoice = (await clack.select({
        message: "Background sync interval",
        options: [
          { value: "0", label: "Manual only", hint: "Run 'moltbot workspace sync' when needed" },
          { value: "300", label: "Every 5 minutes", hint: "Recommended" },
          { value: "600", label: "Every 10 minutes" },
          { value: "1800", label: "Every 30 minutes" },
          { value: "3600", label: "Every hour" },
        ],
      })) as string;

      if (clack.isCancel(intervalChoice)) {
        clack.cancel("Setup cancelled.");
        defaultRuntime.exit(0);
        return;
      }

      const interval = parseInt(intervalChoice, 10);

      // Step 6: Session hooks
      const onSessionStart = (await clack.confirm({
        message: "Sync when session starts?",
        initialValue: true,
      })) as boolean;

      if (clack.isCancel(onSessionStart)) {
        clack.cancel("Setup cancelled.");
        defaultRuntime.exit(0);
        return;
      }

      // Step 7: Save config
      const spinner = clack.spinner();
      spinner.start("Saving configuration...");

      try {
        const cfg = loadConfig();
        const newConfig: MoltbotConfig = {
          ...cfg,
          workspace: {
            ...cfg.workspace,
            sync: {
              provider,
              remotePath: remotePath.trim(),
              localPath: "shared",
              interval,
              onSessionStart,
              onSessionEnd: false,
              ...(useAppFolder && appKey && appSecret
                ? {
                    dropbox: {
                      appFolder: true,
                      appKey: appKey.trim(),
                      appSecret: appSecret.trim(),
                    },
                  }
                : {}),
            },
          },
        };

        await writeConfigFile(newConfig);
        spinner.stop("Configuration saved");
      } catch (err) {
        spinner.stop("Failed to save configuration");
        clack.log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        defaultRuntime.exit(1);
        return;
      }

      // Step 8: OAuth authorization
      clack.log.info("Starting OAuth authorization...");
      clack.note(
        "A browser window will open.\n" + "Log in and authorize access, then return here.",
        "Authorization",
      );

      const authResult = await authorizeRclone(provider, appKey, appSecret);

      if (!authResult.ok) {
        clack.log.error(`Authorization failed: ${authResult.error}`);
        clack.outro("Fix the error and run 'moltbot workspace setup' again.");
        defaultRuntime.exit(1);
        return;
      }

      clack.log.success("Authorization successful");

      // Step 9: Save rclone config
      const stateDir = resolveStateDir(process.env, homedir);
      const configPath = `${stateDir}/.config/rclone/rclone.conf`;
      const remoteName = "cloud";

      const configContent = generateRcloneConfig(provider, remoteName, authResult.token, {
        dropbox: useAppFolder ? { appKey, appSecret } : undefined,
      });

      writeRcloneConfig(configPath, configContent);
      clack.log.success(`rclone config saved to ${shortenHomePath(configPath)}`);

      // Step 10: Create local folder info
      clack.note(
        `Create this folder on your local machine:\n\n` +
          `  ~/Dropbox/${remotePath}/\n\n` +
          `Or wherever your cloud app syncs files.`,
        "Local folder",
      );

      // Step 11: First sync
      const runFirstSync = (await clack.confirm({
        message: "Run first sync now? (--resync)",
        initialValue: true,
      })) as boolean;

      if (runFirstSync && !clack.isCancel(runFirstSync)) {
        const syncSpinner = clack.spinner();
        syncSpinner.start("Running first sync...");

        const cfg = loadConfig();
        const agentId = resolveDefaultAgentId(cfg);
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const resolved = resolveSyncConfig(cfg.workspace?.sync, workspaceDir, stateDir);

        const syncResult = await runBisync({
          configPath: resolved.configPath,
          remoteName: resolved.remoteName,
          remotePath: resolved.remotePath,
          localPath: resolved.localPath,
          conflictResolve: resolved.conflictResolve,
          exclude: resolved.exclude,
          copySymlinks: resolved.copySymlinks,
          resync: true,
        });

        if (syncResult.ok) {
          syncSpinner.stop("First sync completed");
        } else {
          syncSpinner.stop("First sync failed");
          clack.log.warn(`Error: ${syncResult.error}`);
          clack.log.info("You can retry with: moltbot workspace sync --resync");
        }
      }

      // Done!
      clack.outro(colorize(rich, theme.success, "✓ Workspace sync configured!"));

      console.log("");
      console.log("Commands:");
      console.log("  moltbot workspace sync      Sync now");
      console.log("  moltbot workspace status    Check status");
      console.log("  moltbot workspace list      List remote files");
      console.log("");
      console.log(`Docs: ${formatDocsLink("/gateway/workspace-sync")}`);
    });

  // moltbot workspace authorize
  workspace
    .command("authorize")
    .description("Authorize rclone with cloud provider (use 'setup' for guided flow)")
    .option("--provider <name>", "Provider: dropbox, gdrive, onedrive, s3")
    .option("--app-key <key>", "Dropbox app key (for app folder access)")
    .option("--app-secret <secret>", "Dropbox app secret (for app folder access)")
    .action(async (opts: WorkspaceAuthorizeOptions) => {
      const cfg = loadConfig();
      const syncConfig = cfg.workspace?.sync;
      const rich = isRich();

      // Determine provider
      let provider: WorkspaceSyncProvider =
        (opts.provider as WorkspaceSyncProvider) || syncConfig?.provider || "dropbox";

      if (provider === "off" || provider === "custom") {
        console.error(colorize(rich, theme.error, "Please specify a provider: --provider dropbox"));
        defaultRuntime.exit(1);
      }

      // Check rclone
      const installed = await isRcloneInstalled();
      if (!installed) {
        console.error(colorize(rich, theme.error, "rclone not installed."));
        console.error("");
        console.error("Install: curl -s https://rclone.org/install.sh | bash");
        defaultRuntime.exit(1);
      }

      console.log(colorize(rich, theme.info, `Authorizing with ${provider}...`));
      console.log("");
      console.log("A browser window will open for authentication.");
      console.log("Complete the OAuth flow and return here.");
      console.log("");

      const result = await authorizeRclone(
        provider,
        opts.appKey || syncConfig?.dropbox?.appKey,
        opts.appSecret || syncConfig?.dropbox?.appSecret,
      );

      if (!result.ok) {
        console.error(colorize(rich, theme.error, `Authorization failed: ${result.error}`));
        defaultRuntime.exit(1);
      }

      console.log(colorize(rich, theme.success, "✓ Authorization successful"));
      console.log("");

      // Generate and save config
      const stateDir = resolveStateDir(process.env, homedir);
      const remoteName = syncConfig?.remoteName || "cloud";
      const configPath = syncConfig?.configPath || `${stateDir}/.config/rclone/rclone.conf`;

      const configContent = generateRcloneConfig(provider, remoteName, result.token, {
        dropbox: syncConfig?.dropbox,
        s3: syncConfig?.s3,
      });

      writeRcloneConfig(configPath, configContent);

      console.log(`Config saved to: ${shortenHomePath(configPath)}`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Create the remote folder (e.g., ~/Dropbox/moltbot-share/)");
      console.log("  2. Run first sync: moltbot workspace sync --resync");
    });

  // moltbot workspace list
  workspace
    .command("list")
    .description("List files in remote storage")
    .option("--agent <id>", "Agent ID (default: main)")
    .action(async (opts: { agent?: string }) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const stateDir = resolveStateDir(process.env, homedir);
      const syncConfig = cfg.workspace?.sync;

      const rich = isRich();

      if (!syncConfig?.provider || syncConfig.provider === "off") {
        console.error(colorize(rich, theme.error, "Workspace sync not configured."));
        defaultRuntime.exit(1);
      }

      const resolved = resolveSyncConfig(syncConfig, workspaceDir, stateDir);

      // Auto-generate rclone config from moltbot.json if credentials present
      ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

      if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
        console.error(colorize(rich, theme.error, "rclone not configured."));
        console.error("Run: moltbot workspace authorize");
        defaultRuntime.exit(1);
      }

      const result = await listRemote({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
      });

      if (!result.ok) {
        console.error(colorize(rich, theme.error, `Failed to list: ${result.error}`));
        defaultRuntime.exit(1);
      }

      if (result.files.length === 0) {
        console.log(colorize(rich, theme.muted, "No files in remote."));
        return;
      }

      console.log(`${resolved.remoteName}:${resolved.remotePath}/`);
      for (const file of result.files) {
        console.log(`  ${file}`);
      }
      console.log("");
      console.log(colorize(rich, theme.muted, `${result.files.length} files`));
    });
}

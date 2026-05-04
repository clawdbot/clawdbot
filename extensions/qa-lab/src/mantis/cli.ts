import type { Command } from "commander";
import { createLazyCliRuntimeLoader } from "../live-transports/shared/live-transport-cli.js";
import type { MantisDesktopBrowserSmokeOptions } from "./desktop-browser-smoke.runtime.js";
import type { MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";
import type { MantisBeforeAfterOptions } from "./run.runtime.js";
import type { MantisSlackDesktopSmokeOptions } from "./slack-desktop-smoke.runtime.js";

type MantisCliRuntime = typeof import("./cli.runtime.js");

const loadMantisCliRuntime = createLazyCliRuntimeLoader<MantisCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runDiscordSmoke(opts: MantisDiscordSmokeOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisDiscordSmokeCommand(opts);
}

async function runBeforeAfter(opts: MantisBeforeAfterOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisBeforeAfterCommand(opts);
}

async function runDesktopBrowserSmoke(opts: MantisDesktopBrowserSmokeOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisDesktopBrowserSmokeCommand(opts);
}

async function runSlackDesktopSmoke(opts: MantisSlackDesktopSmokeOptions) {
  const runtime = await loadMantisCliRuntime();
  await runtime.runMantisSlackDesktopSmokeCommand(opts);
}

type MantisDiscordSmokeCommanderOptions = {
  channelId?: string;
  guildId?: string;
  message?: string;
  outputDir?: string;
  repoRoot?: string;
  skipPost?: boolean;
  tokenFile?: string;
  tokenFileEnv?: string;
  tokenEnv?: string;
};

type MantisBeforeAfterCommanderOptions = {
  baseline?: string;
  candidate?: string;
  credentialRole?: string;
  credentialSource?: string;
  fast?: boolean;
  outputDir?: string;
  providerMode?: string;
  repoRoot?: string;
  scenario?: string;
  skipBuild?: boolean;
  skipInstall?: boolean;
  transport?: string;
};

type MantisDesktopBrowserSmokeCommanderOptions = {
  browserUrl?: string;
  class?: string;
  crabboxBin?: string;
  htmlFile?: string;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  outputDir?: string;
  provider?: string;
  repoRoot?: string;
  ttl?: string;
};

type MantisSlackDesktopSmokeCommanderOptions = {
  altModel?: string;
  class?: string;
  crabboxBin?: string;
  credentialRole?: string;
  credentialSource?: string;
  fast?: boolean;
  gatewaySetup?: boolean;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  model?: string;
  outputDir?: string;
  provider?: string;
  providerMode?: string;
  repoRoot?: string;
  scenario?: string[];
  slackChannelId?: string;
  slackUrl?: string;
  ttl?: string;
};

function collectString(value: string, previous: string[] = []) {
  return [...previous, value];
}

export function registerMantisCli(qa: Command) {
  const mantis = qa
    .command("mantis")
    .description("Run Mantis before/after and live-smoke verification flows");

  mantis
    .command("run")
    .description("Run a Mantis before/after scenario against baseline and candidate refs")
    .requiredOption("--transport <transport>", "Transport to verify; currently only discord")
    .requiredOption("--scenario <id>", "Mantis scenario id to run")
    .requiredOption("--baseline <ref>", "Ref expected to reproduce the bug")
    .requiredOption("--candidate <ref>", "Ref expected to contain the fix")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis before/after artifact directory")
    .option("--provider-mode <mode>", "QA provider mode", "live-frontier")
    .option("--credential-source <source>", "QA credential source", "convex")
    .option("--credential-role <role>", "QA credential role", "ci")
    .option("--fast", "Enable fast provider mode where supported", true)
    .option("--skip-install", "Skip pnpm install in baseline/candidate worktrees", false)
    .option("--skip-build", "Skip pnpm build in baseline/candidate worktrees", false)
    .action(async (opts: MantisBeforeAfterCommanderOptions) => {
      await runBeforeAfter({
        baseline: opts.baseline,
        candidate: opts.candidate,
        credentialRole: opts.credentialRole,
        credentialSource: opts.credentialSource,
        fastMode: opts.fast,
        outputDir: opts.outputDir,
        providerMode: opts.providerMode,
        repoRoot: opts.repoRoot,
        scenario: opts.scenario,
        skipBuild: opts.skipBuild,
        skipInstall: opts.skipInstall,
        transport: opts.transport,
      });
    });

  mantis
    .command("discord-smoke")
    .description("Verify the Mantis Discord bot can see the guild/channel, post, and react")
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis Discord smoke artifact directory")
    .option("--guild-id <id>", "Override OPENCLAW_QA_DISCORD_GUILD_ID")
    .option("--channel-id <id>", "Override OPENCLAW_QA_DISCORD_CHANNEL_ID")
    .option("--token-env <name>", "Env var containing the Mantis Discord bot token")
    .option("--token-file <path>", "File containing the Mantis Discord bot token")
    .option("--token-file-env <name>", "Env var containing the Mantis Discord bot token file path")
    .option("--message <text>", "Smoke message to post")
    .option("--skip-post", "Only check Discord API visibility; do not post or react", false)
    .action(async (opts: MantisDiscordSmokeCommanderOptions) => {
      await runDiscordSmoke({
        channelId: opts.channelId,
        guildId: opts.guildId,
        message: opts.message,
        outputDir: opts.outputDir,
        repoRoot: opts.repoRoot,
        skipPost: opts.skipPost,
        tokenFile: opts.tokenFile,
        tokenFileEnv: opts.tokenFileEnv,
        tokenEnv: opts.tokenEnv,
      });
    });

  mantis
    .command("desktop-browser-smoke")
    .description(
      "Lease or reuse a Crabbox desktop, open a visible browser, and capture a VNC desktop screenshot",
    )
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis desktop browser artifact directory")
    .option("--browser-url <url>", "URL to open in the visible browser")
    .option("--html-file <path>", "Repo-local HTML file to render in the visible browser")
    .option("--crabbox-bin <path>", "Crabbox binary path")
    .option("--provider <provider>", "Crabbox provider")
    .option("--machine-class <class>", "Crabbox machine class")
    .option("--class <class>", "Alias for --machine-class")
    .option("--lease-id <id>", "Reuse an existing Crabbox lease")
    .option("--idle-timeout <duration>", "Crabbox idle timeout")
    .option("--ttl <duration>", "Crabbox maximum lease lifetime")
    .option("--keep-lease", "Keep a lease created by this run after a passing smoke")
    .action(async (opts: MantisDesktopBrowserSmokeCommanderOptions) => {
      await runDesktopBrowserSmoke({
        browserUrl: opts.browserUrl,
        crabboxBin: opts.crabboxBin,
        htmlFile: opts.htmlFile,
        idleTimeout: opts.idleTimeout,
        keepLease: opts.keepLease,
        leaseId: opts.leaseId,
        machineClass: opts.machineClass ?? opts.class,
        outputDir: opts.outputDir,
        provider: opts.provider,
        repoRoot: opts.repoRoot,
        ttl: opts.ttl,
      });
    });

  mantis
    .command("slack-desktop-smoke")
    .description(
      "Lease or reuse a Crabbox VNC desktop, run Slack QA inside it, open Slack in the browser, and capture a screenshot",
    )
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis Slack desktop artifact directory")
    .option("--crabbox-bin <path>", "Crabbox binary path")
    .option("--provider <provider>", "Crabbox provider")
    .option("--machine-class <class>", "Crabbox machine class")
    .option("--class <class>", "Alias for --machine-class")
    .option("--lease-id <id>", "Reuse an existing Crabbox lease")
    .option("--idle-timeout <duration>", "Crabbox idle timeout")
    .option("--ttl <duration>", "Crabbox maximum lease lifetime")
    .option("--keep-lease", "Keep a lease created by this run after a passing smoke")
    .option("--gateway-setup", "Start a persistent OpenClaw Slack gateway inside the VNC VM")
    .option("--slack-url <url>", "Slack web URL to open in the visible browser")
    .option("--slack-channel-id <id>", "Slack channel id for gateway setup allowlist")
    .option("--provider-mode <mode>", "QA provider mode")
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option(
      "--scenario <id>",
      "Run only the named Slack QA scenario (repeatable)",
      collectString,
      [],
    )
    .option("--credential-source <source>", "Credential source for Slack QA: env or convex")
    .option("--credential-role <role>", "Credential role for convex auth")
    .option("--fast", "Enable provider fast mode where supported")
    .action(async (opts: MantisSlackDesktopSmokeCommanderOptions) => {
      await runSlackDesktopSmoke({
        alternateModel: opts.altModel,
        crabboxBin: opts.crabboxBin,
        credentialRole: opts.credentialRole,
        credentialSource: opts.credentialSource,
        fastMode: opts.fast,
        gatewaySetup: opts.gatewaySetup,
        idleTimeout: opts.idleTimeout,
        keepLease: opts.keepLease,
        leaseId: opts.leaseId,
        machineClass: opts.machineClass ?? opts.class,
        outputDir: opts.outputDir,
        primaryModel: opts.model,
        provider: opts.provider,
        providerMode: opts.providerMode,
        repoRoot: opts.repoRoot,
        scenarioIds: opts.scenario,
        slackChannelId: opts.slackChannelId,
        slackUrl: opts.slackUrl,
        ttl: opts.ttl,
      });
    });
}

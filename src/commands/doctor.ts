import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { confirm, intro, note, outro } from "@clack/prompts";

import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
} from "../agents/sandbox.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { DEFAULT_AGENTS_FILENAME } from "../agents/workspace.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  createConfigIO,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveGatewayPort, resolveIsNixMode } from "../config/paths.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import {
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
} from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import { readProviderAllowFromStore } from "../pairing/pairing-store.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { readTelegramAllowFromStore } from "../telegram/pairing-store.js";
import { resolveTelegramToken } from "../telegram/token.js";
import { normalizeE164, resolveUserPath, sleep } from "../utils.js";
import { healthCommand } from "./health.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  guardCancel,
  printWizardHeader,
} from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

function resolveMode(cfg: ClawdbotConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

function resolveLegacyConfigPath(env: NodeJS.ProcessEnv): string {
  const override = env.CLAWDIS_CONFIG_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".clawdis", "clawdis.json");
}

async function noteSecurityWarnings(cfg: ClawdbotConfig) {
  const warnings: string[] = [];

  const warnDmPolicy = async (params: {
    label: string;
    provider:
      | "telegram"
      | "signal"
      | "imessage"
      | "discord"
      | "slack"
      | "whatsapp";
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const dmPolicy = params.dmPolicy;
    const configAllowFrom = (params.allowFrom ?? []).map((v) =>
      String(v).trim(),
    );
    const hasWildcard = configAllowFrom.includes("*");
    const storeAllowFrom = await readProviderAllowFromStore(
      params.provider,
    ).catch(() => []);
    const normalizedCfg = configAllowFrom
      .filter((v) => v !== "*")
      .map((v) => (params.normalizeEntry ? params.normalizeEntry(v) : v))
      .map((v) => v.trim())
      .filter(Boolean);
    const normalizedStore = storeAllowFrom
      .map((v) => (params.normalizeEntry ? params.normalizeEntry(v) : v))
      .map((v) => v.trim())
      .filter(Boolean);
    const allowCount = Array.from(
      new Set([...normalizedCfg, ...normalizedStore]),
    ).length;

    if (dmPolicy === "open") {
      const policyPath = `${params.allowFromPath}policy`;
      const allowFromPath = `${params.allowFromPath}allowFrom`;
      warnings.push(
        `- ${params.label} DMs: OPEN (${policyPath}="open"). Anyone can DM it.`,
      );
      if (!hasWildcard) {
        warnings.push(
          `- ${params.label} DMs: config invalid — "open" requires ${allowFromPath} to include "*".`,
        );
      }
      return;
    }

    if (dmPolicy === "disabled") {
      const policyPath = `${params.allowFromPath}policy`;
      warnings.push(
        `- ${params.label} DMs: disabled (${policyPath}="disabled").`,
      );
      return;
    }

    if (allowCount === 0) {
      const policyPath = `${params.allowFromPath}policy`;
      warnings.push(
        `- ${params.label} DMs: locked (${policyPath}="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`,
      );
      warnings.push(`  ${params.approveHint}`);
    }
  };

  const telegramConfigured = Boolean(cfg.telegram);
  const { token: telegramToken } = resolveTelegramToken(cfg);
  if (telegramConfigured && telegramToken.trim()) {
    const dmPolicy = cfg.telegram?.dmPolicy ?? "pairing";
    const configAllowFrom = (cfg.telegram?.allowFrom ?? []).map((v) =>
      String(v).trim(),
    );
    const hasWildcard = configAllowFrom.includes("*");
    const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
    const allowCount = Array.from(
      new Set([
        ...configAllowFrom
          .filter((v) => v !== "*")
          .map((v) => v.replace(/^(telegram|tg):/i, ""))
          .filter(Boolean),
        ...storeAllowFrom.filter((v) => v !== "*"),
      ]),
    ).length;

    if (dmPolicy === "open") {
      warnings.push(
        `- Telegram DMs: OPEN (telegram.dmPolicy="open"). Anyone who can find the bot can DM it.`,
      );
      if (!hasWildcard) {
        warnings.push(
          `- Telegram DMs: config invalid — dmPolicy "open" requires telegram.allowFrom to include "*".`,
        );
      }
    } else if (dmPolicy === "disabled") {
      warnings.push(`- Telegram DMs: disabled (telegram.dmPolicy="disabled").`);
    } else if (allowCount === 0) {
      warnings.push(
        `- Telegram DMs: locked (telegram.dmPolicy="${dmPolicy}") with no allowlist; unknown senders will be blocked / get a pairing code.`,
      );
      warnings.push(
        `  Approve via: clawdbot telegram pairing list / clawdbot telegram pairing approve <code>`,
      );
    }

    const groupPolicy = cfg.telegram?.groupPolicy ?? "open";
    const groupAllowlistConfigured =
      cfg.telegram?.groups && Object.keys(cfg.telegram.groups).length > 0;
    if (groupPolicy === "open" && !groupAllowlistConfigured) {
      warnings.push(
        `- Telegram groups: open (groupPolicy="open") with no telegram.groups allowlist; mention-gating applies but any group can add + ping.`,
      );
    }
  }

  if (cfg.discord?.enabled !== false) {
    await warnDmPolicy({
      label: "Discord",
      provider: "discord",
      dmPolicy: cfg.discord?.dm?.policy ?? "pairing",
      allowFrom: cfg.discord?.dm?.allowFrom ?? [],
      allowFromPath: "discord.dm.",
      approveHint:
        "Approve via: clawdbot pairing list --provider discord / clawdbot pairing approve --provider discord <code>",
      normalizeEntry: (raw) =>
        raw.replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
    });
  }

  if (cfg.slack?.enabled !== false) {
    await warnDmPolicy({
      label: "Slack",
      provider: "slack",
      dmPolicy: cfg.slack?.dm?.policy ?? "pairing",
      allowFrom: cfg.slack?.dm?.allowFrom ?? [],
      allowFromPath: "slack.dm.",
      approveHint:
        "Approve via: clawdbot pairing list --provider slack / clawdbot pairing approve --provider slack <code>",
      normalizeEntry: (raw) => raw.replace(/^(slack|user):/i, ""),
    });
  }

  if (cfg.signal?.enabled !== false) {
    await warnDmPolicy({
      label: "Signal",
      provider: "signal",
      dmPolicy: cfg.signal?.dmPolicy ?? "pairing",
      allowFrom: cfg.signal?.allowFrom ?? [],
      allowFromPath: "signal.",
      approveHint:
        "Approve via: clawdbot pairing list --provider signal / clawdbot pairing approve --provider signal <code>",
      normalizeEntry: (raw) =>
        normalizeE164(raw.replace(/^signal:/i, "").trim()),
    });
  }

  if (cfg.imessage?.enabled !== false) {
    await warnDmPolicy({
      label: "iMessage",
      provider: "imessage",
      dmPolicy: cfg.imessage?.dmPolicy ?? "pairing",
      allowFrom: cfg.imessage?.allowFrom ?? [],
      allowFromPath: "imessage.",
      approveHint:
        "Approve via: clawdbot pairing list --provider imessage / clawdbot pairing approve --provider imessage <code>",
    });
  }

  if (cfg.whatsapp) {
    await warnDmPolicy({
      label: "WhatsApp",
      provider: "whatsapp",
      dmPolicy: cfg.whatsapp?.dmPolicy ?? "pairing",
      allowFrom: cfg.whatsapp?.allowFrom ?? [],
      allowFromPath: "whatsapp.",
      approveHint:
        "Approve via: clawdbot pairing list --provider whatsapp / clawdbot pairing approve --provider whatsapp <code>",
      normalizeEntry: (raw) => normalizeE164(raw),
    });
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Security");
  }
}

function replacePathSegment(
  value: string | undefined,
  from: string,
  to: string,
): string | undefined {
  if (!value) return value;
  const pattern = new RegExp(`(^|[\\/])${from}([\\/]|$)`, "g");
  if (!pattern.test(value)) return value;
  return value.replace(pattern, `$1${to}$2`);
}

function replaceLegacyName(value: string | undefined): string | undefined {
  if (!value) return value;
  const replacedClawdis = value.replace(/clawdis/g, "clawdbot");
  return replacedClawdis.replace(/clawd(?!bot)/g, "clawdbot");
}

function replaceModernName(value: string | undefined): string | undefined {
  if (!value) return value;
  if (!value.includes("clawdbot")) return value;
  return value.replace(/clawdbot/g, "clawdis");
}

type SandboxScriptInfo = {
  scriptPath: string;
  cwd: string;
};

function resolveSandboxScript(scriptRel: string): SandboxScriptInfo | null {
  const candidates = new Set<string>();
  candidates.add(process.cwd());
  const argv1 = process.argv[1];
  if (argv1) {
    const normalized = path.resolve(argv1);
    candidates.add(path.resolve(path.dirname(normalized), ".."));
    candidates.add(path.resolve(path.dirname(normalized)));
  }

  for (const root of candidates) {
    const scriptPath = path.join(root, scriptRel);
    if (fs.existsSync(scriptPath)) {
      return { scriptPath, cwd: root };
    }
  }

  return null;
}

async function runSandboxScript(
  scriptRel: string,
  runtime: RuntimeEnv,
): Promise<boolean> {
  const script = resolveSandboxScript(scriptRel);
  if (!script) {
    note(
      `Unable to locate ${scriptRel}. Run it from the repo root.`,
      "Sandbox",
    );
    return false;
  }

  runtime.log(`Running ${scriptRel}...`);
  const result = await runCommandWithTimeout(["bash", script.scriptPath], {
    timeoutMs: 20 * 60 * 1000,
    cwd: script.cwd,
  });
  if (result.code !== 0) {
    runtime.error(
      `Failed running ${scriptRel}: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
    return false;
  }

  runtime.log(`Completed ${scriptRel}.`);
  return true;
}

type DoctorOptions = {
  workspaceSuggestions?: boolean;
};

const MEMORY_SYSTEM_PROMPT = [
  "Memory system not found in workspace.",
  "Paste this into your agent:",
  "",
  "Install the memory system by applying:",
  "https://github.com/clawdbot/clawdbot/commit/9ffea23f31ca1df5183b25668f8f814bee0fb34e",
  "https://github.com/clawdbot/clawdbot/commit/7d1fee70e76f2f634f1b41fca927ee663914183a",
].join("\n");

async function shouldSuggestMemorySystem(
  workspaceDir: string,
): Promise<boolean> {
  const memoryPaths = [
    path.join(workspaceDir, "MEMORY.md"),
    path.join(workspaceDir, "memory.md"),
  ];

  for (const memoryPath of memoryPaths) {
    try {
      await fs.promises.access(memoryPath);
      return false;
    } catch {
      // keep scanning
    }
  }

  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  try {
    const content = await fs.promises.readFile(agentsPath, "utf-8");
    if (/memory\.md/i.test(content)) return false;
  } catch {
    // no AGENTS.md or unreadable; treat as missing memory guidance
  }

  return true;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await runExec("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await runExec("docker", ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveSandboxDockerImage(cfg: ClawdbotConfig): string {
  const image = cfg.agent?.sandbox?.docker?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_IMAGE;
}

function resolveSandboxBrowserImage(cfg: ClawdbotConfig): string {
  const image = cfg.agent?.sandbox?.browser?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}

function updateSandboxDockerImage(
  cfg: ClawdbotConfig,
  image: string,
): ClawdbotConfig {
  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      sandbox: {
        ...cfg.agent?.sandbox,
        docker: {
          ...cfg.agent?.sandbox?.docker,
          image,
        },
      },
    },
  };
}

function updateSandboxBrowserImage(
  cfg: ClawdbotConfig,
  image: string,
): ClawdbotConfig {
  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      sandbox: {
        ...cfg.agent?.sandbox,
        browser: {
          ...cfg.agent?.sandbox?.browser,
          image,
        },
      },
    },
  };
}

type SandboxImageCheck = {
  label: string;
  image: string;
  buildScript?: string;
  updateConfig: (image: string) => void;
};

async function handleMissingSandboxImage(
  params: SandboxImageCheck,
  runtime: RuntimeEnv,
) {
  const exists = await dockerImageExists(params.image);
  if (exists) return;

  const buildHint = params.buildScript
    ? `Build it with ${params.buildScript}.`
    : "Build or pull it first.";
  note(
    `Sandbox ${params.label} image missing: ${params.image}. ${buildHint}`,
    "Sandbox",
  );

  let built = false;
  if (params.buildScript) {
    const build = guardCancel(
      await confirm({
        message: `Build ${params.label} sandbox image now?`,
        initialValue: true,
      }),
      runtime,
    );
    if (build) {
      built = await runSandboxScript(params.buildScript, runtime);
    }
  }

  if (built) return;

  const legacyImage = replaceModernName(params.image);
  if (!legacyImage || legacyImage === params.image) return;
  const legacyExists = await dockerImageExists(legacyImage);
  if (!legacyExists) return;

  const fallback = guardCancel(
    await confirm({
      message: `Switch config to legacy image ${legacyImage}?`,
      initialValue: false,
    }),
    runtime,
  );
  if (!fallback) return;

  params.updateConfig(legacyImage);
}

async function maybeRepairSandboxImages(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig> {
  const sandbox = cfg.agent?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") return cfg;

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    note("Docker not available; skipping sandbox image checks.", "Sandbox");
    return cfg;
  }

  let next = cfg;
  const changes: string[] = [];

  const dockerImage = resolveSandboxDockerImage(cfg);
  await handleMissingSandboxImage(
    {
      label: "base",
      image: dockerImage,
      buildScript:
        dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
          ? "scripts/sandbox-common-setup.sh"
          : dockerImage === DEFAULT_SANDBOX_IMAGE
            ? "scripts/sandbox-setup.sh"
            : undefined,
      updateConfig: (image) => {
        next = updateSandboxDockerImage(next, image);
        changes.push(`Updated agent.sandbox.docker.image → ${image}`);
      },
    },
    runtime,
  );

  if (sandbox.browser?.enabled) {
    await handleMissingSandboxImage(
      {
        label: "browser",
        image: resolveSandboxBrowserImage(cfg),
        buildScript: "scripts/sandbox-browser-setup.sh",
        updateConfig: (image) => {
          next = updateSandboxBrowserImage(next, image);
          changes.push(`Updated agent.sandbox.browser.image → ${image}`);
        },
      },
      runtime,
    );
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }

  return next;
}

function normalizeLegacyConfigValues(cfg: ClawdbotConfig): {
  config: ClawdbotConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: ClawdbotConfig = cfg;

  const workspace = cfg.agent?.workspace;
  const updatedWorkspace = replacePathSegment(
    replacePathSegment(workspace, "clawdis", "clawdbot"),
    "clawd",
    "clawdbot",
  );
  if (updatedWorkspace && updatedWorkspace !== workspace) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        workspace: updatedWorkspace,
      },
    };
    changes.push(`Updated agent.workspace → ${updatedWorkspace}`);
  }

  const workspaceRoot = cfg.agent?.sandbox?.workspaceRoot;
  const updatedWorkspaceRoot = replacePathSegment(
    replacePathSegment(workspaceRoot, "clawdis", "clawdbot"),
    "clawd",
    "clawdbot",
  );
  if (updatedWorkspaceRoot && updatedWorkspaceRoot !== workspaceRoot) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          workspaceRoot: updatedWorkspaceRoot,
        },
      },
    };
    changes.push(
      `Updated agent.sandbox.workspaceRoot → ${updatedWorkspaceRoot}`,
    );
  }

  const dockerImage = cfg.agent?.sandbox?.docker?.image;
  const updatedDockerImage = replaceLegacyName(dockerImage);
  if (updatedDockerImage && updatedDockerImage !== dockerImage) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          docker: {
            ...next.agent?.sandbox?.docker,
            image: updatedDockerImage,
          },
        },
      },
    };
    changes.push(`Updated agent.sandbox.docker.image → ${updatedDockerImage}`);
  }

  const containerPrefix = cfg.agent?.sandbox?.docker?.containerPrefix;
  const updatedContainerPrefix = replaceLegacyName(containerPrefix);
  if (updatedContainerPrefix && updatedContainerPrefix !== containerPrefix) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        sandbox: {
          ...next.agent?.sandbox,
          docker: {
            ...next.agent?.sandbox?.docker,
            containerPrefix: updatedContainerPrefix,
          },
        },
      },
    };
    changes.push(
      `Updated agent.sandbox.docker.containerPrefix → ${updatedContainerPrefix}`,
    );
  }

  return { config: next, changes };
}

async function maybeMigrateLegacyConfigFile(runtime: RuntimeEnv) {
  const legacyConfigPath = resolveLegacyConfigPath(process.env);
  if (legacyConfigPath === CONFIG_PATH_CLAWDBOT) return;

  const legacyIo = createConfigIO({ configPath: legacyConfigPath });
  const legacySnapshot = await legacyIo.readConfigFileSnapshot();
  if (!legacySnapshot.exists) return;

  const currentSnapshot = await readConfigFileSnapshot();
  if (currentSnapshot.exists) {
    note(
      `Legacy config still exists at ${legacyConfigPath}. Current config at ${CONFIG_PATH_CLAWDBOT}.`,
      "Legacy config",
    );
    return;
  }

  const gatewayMode =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.gateway?.mode === "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).gateway?.mode
      : undefined;
  const gatewayBind =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.gateway?.bind === "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).gateway?.bind
      : undefined;
  const agentWorkspace =
    typeof (legacySnapshot.parsed as ClawdbotConfig)?.agent?.workspace ===
    "string"
      ? (legacySnapshot.parsed as ClawdbotConfig).agent?.workspace
      : undefined;

  note(
    [
      `- File exists at ${legacyConfigPath}`,
      gatewayMode ? `- gateway.mode: ${gatewayMode}` : undefined,
      gatewayBind ? `- gateway.bind: ${gatewayBind}` : undefined,
      agentWorkspace ? `- agent.workspace: ${agentWorkspace}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    "Legacy Clawdis config detected",
  );

  let nextConfig = legacySnapshot.valid ? legacySnapshot.config : null;
  const { config: migratedConfig, changes } = migrateLegacyConfig(
    legacySnapshot.parsed,
  );
  if (migratedConfig) {
    nextConfig = migratedConfig;
  } else if (!nextConfig) {
    note(
      `Legacy config at ${legacyConfigPath} is invalid; skipping migration.`,
      "Legacy config",
    );
    return;
  }

  const normalized = normalizeLegacyConfigValues(nextConfig);
  const mergedChanges = [...changes, ...normalized.changes];
  if (mergedChanges.length > 0) {
    note(mergedChanges.join("\n"), "Doctor changes");
  }

  await writeConfigFile(normalized.config);
  runtime.log(`Migrated legacy config to ${CONFIG_PATH_CLAWDBOT}`);
}

async function maybeMigrateLegacyGatewayService(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
) {
  const legacyServices = await findLegacyGatewayServices(process.env);
  if (legacyServices.length === 0) return;

  note(
    legacyServices
      .map((svc) => `- ${svc.label} (${svc.platform}, ${svc.detail})`)
      .join("\n"),
    "Legacy Clawdis services detected",
  );

  const migrate = guardCancel(
    await confirm({
      message: "Migrate legacy Clawdis services to Clawdbot now?",
      initialValue: true,
    }),
    runtime,
  );
  if (!migrate) return;

  try {
    await uninstallLegacyGatewayServices({
      env: process.env,
      stdout: process.stdout,
    });
  } catch (err) {
    runtime.error(`Legacy service cleanup failed: ${String(err)}`);
    return;
  }

  if (resolveIsNixMode(process.env)) {
    note("Nix mode detected; skip installing services.", "Gateway");
    return;
  }

  if (resolveMode(cfg) === "remote") {
    note("Gateway mode is remote; skipped local service install.", "Gateway");
    return;
  }

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  if (loaded) {
    note(`Clawdbot ${service.label} already ${service.loadedText}.`, "Gateway");
    return;
  }

  const install = guardCancel(
    await confirm({
      message: "Install Clawdbot gateway service now?",
      initialValue: true,
    }),
    runtime,
  );
  if (!install) return;

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const port = resolveGatewayPort(cfg, process.env);
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({ port, dev: devMode });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CLAWDBOT_GATEWAY_TOKEN:
      cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    CLAWDBOT_LAUNCHD_LABEL:
      process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
  };
  await service.install({
    env: process.env,
    stdout: process.stdout,
    programArguments,
    workingDirectory,
    environment,
  });
}

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  printWizardHeader(runtime);
  intro("Clawdbot doctor");

  await maybeMigrateLegacyConfigFile(runtime);

  const snapshot = await readConfigFileSnapshot();
  let cfg: ClawdbotConfig = snapshot.valid ? snapshot.config : {};
  if (
    snapshot.exists &&
    !snapshot.valid &&
    snapshot.legacyIssues.length === 0
  ) {
    note("Config invalid; doctor will run with defaults.", "Config");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n"),
      "Legacy config keys detected",
    );
    const migrate = guardCancel(
      await confirm({
        message: "Migrate legacy config entries now?",
        initialValue: true,
      }),
      runtime,
    );
    if (migrate) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into whatsapp.allowFrom.
      const { config: migrated, changes } = migrateLegacyConfig(
        snapshot.parsed,
      );
      if (changes.length > 0) {
        note(changes.join("\n"), "Doctor changes");
      }
      if (migrated) {
        cfg = migrated;
      }
    }
  }

  const normalized = normalizeLegacyConfigValues(cfg);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    cfg = normalized.config;
  }

  cfg = await maybeRepairSandboxImages(cfg, runtime);

  await maybeMigrateLegacyGatewayService(cfg, runtime);

  await noteSecurityWarnings(cfg);

  if (process.platform === "linux" && resolveMode(cfg) === "local") {
    const service = resolveGatewayService();
    let loaded = false;
    try {
      loaded = await service.isLoaded({ env: process.env });
    } catch {
      loaded = false;
    }
    if (loaded) {
      await ensureSystemdUserLingerInteractive({
        runtime,
        prompter: {
          confirm: async (p) => guardCancel(await confirm(p), runtime) === true,
          note,
        },
        reason:
          "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
        requireConfirm: true,
      });
    }
  }

  const workspaceDir = resolveUserPath(
    cfg.agent?.workspace ?? DEFAULT_WORKSPACE,
  );
  const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  note(
    [
      `Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
      `Missing requirements: ${
        skillsReport.skills.filter(
          (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
        ).length
      }`,
      `Blocked by allowlist: ${
        skillsReport.skills.filter((s) => s.blockedByAllowlist).length
      }`,
    ].join("\n"),
    "Skills status",
  );

  let healthOk = false;
  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    healthOk = true;
  } catch (err) {
    const message = String(err);
    if (message.includes("gateway closed")) {
      note("Gateway not running.", "Gateway");
    } else {
      runtime.error(`Health check failed: ${message}`);
    }
  }

  if (!healthOk) {
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (!loaded) {
      note("Gateway daemon not installed.", "Gateway");
    } else {
      if (process.platform === "darwin") {
        note(
          `LaunchAgent loaded; stopping requires "clawdbot gateway stop" or launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}.`,
          "Gateway",
        );
      }
      const restart = guardCancel(
        await confirm({
          message: "Restart gateway daemon now?",
          initialValue: true,
        }),
        runtime,
      );
      if (restart) {
        await service.restart({ stdout: process.stdout });
        await sleep(1500);
        try {
          await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
        } catch (err) {
          const message = String(err);
          if (message.includes("gateway closed")) {
            note("Gateway not running.", "Gateway");
          } else {
            runtime.error(`Health check failed: ${message}`);
          }
        }
      }
    }
  }

  cfg = applyWizardMetadata(cfg, { command: "doctor", mode: resolveMode(cfg) });
  await writeConfigFile(cfg);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  if (options.workspaceSuggestions !== false) {
    const workspaceDir = resolveUserPath(
      cfg.agent?.workspace ?? DEFAULT_WORKSPACE,
    );
    if (await shouldSuggestMemorySystem(workspaceDir)) {
      note(MEMORY_SYSTEM_PROMPT, "Workspace");
    }
  }

  outro("Doctor complete.");
}

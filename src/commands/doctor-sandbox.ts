/** Doctor checks and repairs for Docker sandbox images, namespaces, and registry state. */
import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  isDockerDaemonUnavailable,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import {
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
  validateSandboxContainerEngineTarget,
} from "../agents/sandbox/docker.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
  type LegacySandboxRegistryInspection,
  type LegacySandboxRegistryMigrationResult,
} from "./doctor-sandbox-legacy-registry.js";

const SANDBOX_REGISTRY_FILES_CHECK_ID = "core/doctor/sandbox/registry-files";

type SandboxScriptInfo = {
  scriptPath: string;
  cwd: string;
};

function resolveSandboxScript(
  scriptRel: string,
  options: { argv1?: string; cwd?: string } = {},
): SandboxScriptInfo | null {
  // Scan every openclaw package root the shared resolver finds (symlinked launcher via realpath,
  // then cwd) and return the first that actually holds the script. The resolver follows npm/pnpm
  // global bins and version-manager links, but a published package root can resolve first and ship
  // without scripts/sandbox-setup.sh (the npm files allowlist drops scripts/); stopping at the
  // first root would then skip a valid source-checkout cwd that still has it.
  const roots = resolveOpenClawPackageRootsSync({
    cwd: options.cwd ?? process.cwd(),
    argv1: options.argv1 ?? process.argv[1],
  });
  for (const root of roots) {
    const scriptPath = path.join(root, scriptRel);
    if (fs.existsSync(scriptPath)) {
      return { scriptPath, cwd: root };
    }
  }
  return null;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.doctorSandboxTestApi")] = {
    resolveSandboxScript,
  };
}

async function runSandboxScript(scriptRel: string, runtime: RuntimeEnv): Promise<boolean> {
  const script = resolveSandboxScript(scriptRel);
  if (!script) {
    note(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
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

async function isContainerEngineAvailable(command: "docker" | "podman"): Promise<boolean> {
  try {
    await runExec(
      command,
      command === "docker" ? ["version", "--format", "{{.Server.Version}}"] : ["info"],
      {
        timeoutMs: 5_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

type CodexBwrapNamespaceProbe =
  | { ok: true }
  | { ok: false; kind: "user" | "network"; command: string; reason: string };

function formatNamespaceProbeCommand(args: string[]): string {
  return ["unshare", ...args].join(" ");
}

async function runCodexBwrapNamespaceProbe(
  kind: "user" | "network",
  args: string[],
): Promise<CodexBwrapNamespaceProbe> {
  try {
    await runExec("unshare", args, {
      timeoutMs: 5_000,
    });
    return { ok: true };
  } catch (error) {
    const reason =
      (error as { stderr?: string } | undefined)?.stderr?.trim() ||
      (error as { stdout?: string } | undefined)?.stdout?.trim() ||
      (error instanceof Error ? error.message : String(error));
    return { ok: false, kind, command: formatNamespaceProbeCommand(args), reason };
  }
}

function codexBwrapNeedsNetworkNamespaceProbe(cfg: OpenClawConfig): boolean {
  const network = cfg.agents?.defaults?.sandbox?.docker?.network?.trim().toLowerCase();
  return network === undefined || network === "" || network === "none";
}

async function probeCodexBwrapNamespaces(cfg: OpenClawConfig): Promise<CodexBwrapNamespaceProbe> {
  if (process.platform !== "linux") {
    return { ok: true };
  }
  const userProbe = await runCodexBwrapNamespaceProbe("user", [
    "--user",
    "--map-root-user",
    "true",
  ]);
  if (!userProbe.ok || !codexBwrapNeedsNetworkNamespaceProbe(cfg)) {
    return userProbe;
  }
  return await runCodexBwrapNamespaceProbe("network", [
    "--user",
    "--map-root-user",
    "--net",
    "true",
  ]);
}

async function noteCodexBwrapNamespaceWarning(
  cfg: OpenClawConfig,
  engineName: "Docker" | "Podman",
): Promise<void> {
  const probe = await probeCodexBwrapNamespaces(cfg);
  if (probe.ok) {
    return;
  }
  const symptom =
    probe.kind === "user"
      ? "  bwrap: setting up uid map: Permission denied"
      : "  bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
  const networkSentence = codexBwrapNeedsNetworkNamespaceProbe(cfg)
    ? `With ${engineName} sandbox network egress disabled, it also needs an unprivileged network namespace.`
    : `${engineName} sandbox network egress is enabled, so doctor only checked the user namespace.`;
  const lines = [
    `Codex bwrap ${probe.kind} namespace probe failed while ${engineName} sandbox mode is enabled.`,
    `Codex app-server \`workspace-write\` shell execution needs unprivileged user namespaces. ${networkSentence}`,
    "On Ubuntu/AppArmor hosts this usually appears as:",
    symptom,
    `Probe command: ${probe.command}`,
    `Probe result: ${probe.reason}`,
    "",
    "Fix the host namespace policy for the OpenClaw service user, then restart the gateway.",
    "Prefer an AppArmor profile that grants the required namespaces to the OpenClaw service process.",
    "`kernel.apparmor_restrict_unprivileged_userns=0` is a host-wide fallback with security tradeoffs; use it only when that host posture is acceptable.",
    "Do not add broad Docker container privileges just to satisfy nested bwrap; that weakens the outer sandbox.",
  ];
  note(lines.join("\n"), "Sandbox");
}

async function containerImageExists(command: "docker" | "podman", image: string): Promise<boolean> {
  try {
    await runExec(command, ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch (error) {
    const stderr =
      (error as { stderr: string } | undefined)?.stderr ||
      (error as { message: string } | undefined)?.message ||
      "";
    const imageMissing =
      command === "docker"
        ? stderr.includes("No such image")
        : /No such image|image not known|image .* not found/iu.test(stderr);
    if (imageMissing) {
      return false;
    }
    if (command === "docker" && isDockerDaemonUnavailable(stderr)) {
      return false;
    }
    throw error;
  }
}

function resolveSandboxDockerImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.docker?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_IMAGE;
}

function resolveSandboxBackend(cfg: OpenClawConfig): string {
  const backend = cfg.agents?.defaults?.sandbox?.backend?.trim();
  return (backend || "docker").toLowerCase();
}

function resolveSandboxBrowserImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.browser?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}

function updateSandboxDockerImage(cfg: OpenClawConfig, image: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        sandbox: {
          ...cfg.agents?.defaults?.sandbox,
          docker: {
            ...cfg.agents?.defaults?.sandbox?.docker,
            image,
          },
        },
      },
    },
  };
}

function updateSandboxBrowserImage(cfg: OpenClawConfig, image: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        sandbox: {
          ...cfg.agents?.defaults?.sandbox,
          browser: {
            ...cfg.agents?.defaults?.sandbox?.browser,
            image,
          },
        },
      },
    },
  };
}

type SandboxImageCheck = {
  engineCommand: "docker" | "podman";
  kind: string;
  image: string;
  buildScript?: string;
  updateConfig: (image: string) => void;
};

async function handleMissingSandboxImage(
  params: SandboxImageCheck,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const exists = await containerImageExists(params.engineCommand, params.image);
  if (exists) {
    return;
  }

  const buildHint = params.buildScript
    ? `Build it with ${params.buildScript}.`
    : "Build or pull it first.";
  note(`Sandbox ${params.kind} image missing: ${params.image}. ${buildHint}`, "Sandbox");

  if (params.buildScript) {
    const build = await prompter.confirmRuntimeRepair({
      message: `Build ${params.kind} sandbox image now?`,
      initialValue: true,
    });
    if (build) {
      await runSandboxScript(params.buildScript, runtime);
    }
  }
}

/**
 * Checks configured sandbox images and optionally runs repo build scripts for missing defaults.
 *
 * Non-container backends skip image checks; local container mode also probes Codex bwrap namespace
 * support because nested app-server shells rely on host user/network namespace policy.
 */
export async function maybeRepairSandboxImages(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return cfg;
  }
  const backend = resolveSandboxBackend(cfg);
  if (backend !== "docker" && backend !== "podman") {
    if (sandbox.browser?.enabled) {
      note(
        `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
        "Sandbox",
      );
    }
    return cfg;
  }
  const containerEngine = backend === "podman" ? PODMAN_SANDBOX_ENGINE : DOCKER_SANDBOX_ENGINE;

  const engineAvailable = await isContainerEngineAvailable(containerEngine.command);
  if (!engineAvailable) {
    const lines =
      containerEngine.id === "docker"
        ? [
            `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
            "Docker is required for sandbox mode to function.",
            "Isolated sessions (automations, sub-agents) will fail without Docker.",
            "",
            "Options:",
            "- Install Docker and restart the gateway",
            "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
          ]
        : [
            `Sandbox mode is enabled (mode: "${mode}") but Podman is not available.`,
            "Podman is required by the selected sandbox backend.",
            "Isolated sessions (automations, sub-agents) will fail without Podman.",
            "",
            "Options:",
            "- Install Podman and restart the gateway",
            "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
          ];
    note(lines.join("\n"), "Sandbox");
    return cfg;
  }
  await validateSandboxContainerEngineTarget(containerEngine);
  await noteCodexBwrapNamespaceWarning(cfg, containerEngine.displayName);

  let next = cfg;
  const changes: string[] = [];

  const dockerImage = resolveSandboxDockerImage(cfg);
  await handleMissingSandboxImage(
    {
      engineCommand: containerEngine.command,
      kind: "base",
      image: dockerImage,
      buildScript:
        containerEngine.id !== "docker"
          ? undefined
          : dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
            ? "scripts/sandbox-common-setup.sh"
            : dockerImage === DEFAULT_SANDBOX_IMAGE
              ? "scripts/sandbox-setup.sh"
              : undefined,
      updateConfig: (image) => {
        next = updateSandboxDockerImage(next, image);
        changes.push(`Updated agents.defaults.sandbox.docker.image → ${image}`);
      },
    },
    runtime,
    prompter,
  );

  if (sandbox.browser?.enabled && containerEngine.id === "docker") {
    await handleMissingSandboxImage(
      {
        engineCommand: containerEngine.command,
        kind: "browser",
        image: resolveSandboxBrowserImage(cfg),
        buildScript: "scripts/sandbox-browser-setup.sh",
        updateConfig: (image) => {
          next = updateSandboxBrowserImage(next, image);
          changes.push(`Updated agents.defaults.sandbox.browser.image → ${image}`);
        },
      },
      runtime,
      prompter,
    );
  } else if (sandbox.browser?.enabled) {
    note(
      "Podman sandbox selected. Browser sandbox health checks are skipped because browser sandboxing requires the Docker engine.",
      "Sandbox",
    );
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }

  return next;
}

function formatLegacyRegistryInspectionLine(file: LegacySandboxRegistryInspection): string {
  const status = file.valid ? `${file.entries} entr${file.entries === 1 ? "y" : "ies"}` : "invalid";
  return `- ${file.kind} ${file.source}: ${shortenHomePath(file.path)} (${status})`;
}

function formatLegacyRegistryMigrationLine(result: LegacySandboxRegistryMigrationResult): string {
  if (result.status === "migrated") {
    return `- Migrated ${result.kind} registry into ${result.entries} SQLite row${result.entries === 1 ? "" : "s"}.`;
  }
  if (result.status === "removed-empty") {
    return `- Removed empty legacy ${result.kind} registry files.`;
  }
  if (result.status === "quarantined-invalid") {
    const file = shortenHomePath(result.path);
    const quarantine = ` to ${shortenHomePath(result.quarantinePath)}`;
    return `- Quarantined invalid legacy ${result.kind} registry ${file}${quarantine}.`;
  }
  return "";
}

export async function detectLegacySandboxRegistryFileIssues(): Promise<
  readonly LegacySandboxRegistryInspection[]
> {
  return (await inspectLegacySandboxRegistryFiles()).filter((file) => file.exists);
}

export function legacySandboxRegistryInspectionToHealthFinding(
  file: LegacySandboxRegistryInspection,
): HealthFinding {
  return {
    checkId: SANDBOX_REGISTRY_FILES_CHECK_ID,
    severity: "warning",
    message: `Legacy sandbox registry file detected.
${formatLegacyRegistryInspectionLine(file)}`,
    path: file.path,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to migrate valid entries to SQLite.`,
  };
}

export function legacySandboxRegistryInspectionToRepairEffect(
  file: LegacySandboxRegistryInspection,
): HealthRepairEffect {
  const action = !file.valid
    ? "would-quarantine-legacy-sandbox-registry"
    : file.entries === 0
      ? "would-remove-empty-legacy-sandbox-registry"
      : "would-migrate-legacy-sandbox-registry";
  return {
    kind: "state",
    action,
    target: file.path,
    dryRunSafe: false,
  };
}

/** Migrates legacy sandbox registry files and directories. */
export async function maybeRepairSandboxRegistryFiles(prompter: DoctorPrompter): Promise<void> {
  const legacyFiles = await detectLegacySandboxRegistryFileIssues();
  if (legacyFiles.length === 0) {
    return;
  }

  if (!prompter.shouldRepair) {
    note(
      [
        "Legacy sandbox registry files detected.",
        ...legacyFiles.map(formatLegacyRegistryInspectionLine),
        `Run ${formatCliCommand("openclaw doctor --fix")} to migrate them to SQLite.`,
      ].join("\n"),
      "Sandbox",
    );
    return;
  }

  const results = (await migrateLegacySandboxRegistryFiles())
    .filter((result) => result.status !== "missing")
    .map(formatLegacyRegistryMigrationLine)
    .filter((line) => line.length > 0);
  if (results.length > 0) {
    note(results.join("\n"), "Doctor changes");
  }
}

/** Warns when agent sandbox overrides are ignored because sandbox scope resolves to shared. */
export function noteSandboxScopeWarnings(cfg: OpenClawConfig) {
  const globalSandbox = cfg.agents?.defaults?.sandbox;
  const warnings: string[] = [];

  for (const agent of listAgentEntries(cfg)) {
    const agentId = agent.id;
    const agentSandbox = agent.sandbox;
    if (!agentSandbox) {
      continue;
    }

    const scope = resolveSandboxScope({
      scope: agentSandbox.scope ?? globalSandbox?.scope,
    });

    if (scope !== "shared") {
      continue;
    }

    const overrides: string[] = [];
    if (agentSandbox.docker && Object.keys(agentSandbox.docker).length > 0) {
      overrides.push("docker");
    }
    if (agentSandbox.browser && Object.keys(agentSandbox.browser).length > 0) {
      overrides.push("browser");
    }
    if (agentSandbox.prune && Object.keys(agentSandbox.prune).length > 0) {
      overrides.push("prune");
    }

    if (overrides.length === 0) {
      continue;
    }

    warnings.push(
      [
        `- agents.entries.${agentId} sandbox ${overrides.join("/")} overrides ignored.`,
        `  scope resolves to "shared".`,
      ].join("\n"),
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}

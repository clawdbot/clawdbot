import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  isDockerDaemonUnavailable,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import {
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
  type LegacySandboxRegistryInspection,
  type LegacySandboxRegistryMigrationResult,
} from "../agents/sandbox/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

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

async function noteCodexBwrapNamespaceWarning(cfg: OpenClawConfig): Promise<void> {
  const probe = await probeCodexBwrapNamespaces(cfg);
  if (probe.ok) {
    return;
  }
  const symptom =
    probe.kind === "user"
      ? "  bwrap: setting up uid map: Permission denied"
      : "  bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
  const networkSentence = codexBwrapNeedsNetworkNamespaceProbe(cfg)
    ? "With Docker sandbox network egress disabled, it also needs an unprivileged network namespace."
    : "Docker sandbox network egress is enabled, so doctor only checked the user namespace.";
  const lines = [
    `Codex bwrap ${probe.kind} namespace probe failed while Docker sandbox mode is enabled.`,
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

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await runExec("docker", ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch (error) {
    const stderr =
      (error as { stderr: string } | undefined)?.stderr ||
      (error as { message: string } | undefined)?.message ||
      "";
    if (stderr.includes("No such image")) {
      return false;
    }
    if (isDockerDaemonUnavailable(stderr)) {
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
  return backend || "docker";
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
  const exists = await dockerImageExists(params.image);
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
  if (backend !== "docker") {
    if (sandbox.browser?.enabled) {
      note(
        `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
        "Sandbox",
      );
    }
    return cfg;
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    const lines = [
      `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
      "Docker is required for sandbox mode to function.",
      "Isolated sessions (cron jobs, sub-agents) will fail without Docker.",
      "",
      "Options:",
      "- Install Docker and restart the gateway",
      "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
    ];
    note(lines.join("\n"), "Sandbox");
    return cfg;
  }
  await noteCodexBwrapNamespaceWarning(cfg);

  let next = cfg;
  const changes: string[] = [];

  const dockerImage = resolveSandboxDockerImage(cfg);
  await handleMissingSandboxImage(
    {
      kind: "base",
      image: dockerImage,
      buildScript:
        dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
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

  if (sandbox.browser?.enabled) {
    await handleMissingSandboxImage(
      {
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
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }

  return next;
}

function formatLegacyRegistryInspectionLine(file: LegacySandboxRegistryInspection): string {
  const status = file.valid ? `${file.entries} entr${file.entries === 1 ? "y" : "ies"}` : "invalid";
  return `- ${file.kind}: ${shortenHomePath(file.registryPath)} (${status})`;
}

function formatLegacyRegistryMigrationLine(result: LegacySandboxRegistryMigrationResult): string {
  const file = shortenHomePath(result.registryPath);
  if (result.status === "migrated") {
    return `- Migrated ${result.kind} registry from ${file} into ${result.entries} shard${result.entries === 1 ? "" : "s"}.`;
  }
  if (result.status === "removed-empty") {
    return `- Removed empty legacy ${result.kind} registry ${file}.`;
  }
  if (result.status === "quarantined-invalid") {
    const quarantine = result.quarantinePath ? ` to ${shortenHomePath(result.quarantinePath)}` : "";
    return `- Quarantined invalid legacy ${result.kind} registry ${file}${quarantine}.`;
  }
  return "";
}

export async function maybeRepairSandboxRegistryFiles(prompter: DoctorPrompter): Promise<void> {
  const legacyFiles = (await inspectLegacySandboxRegistryFiles()).filter((file) => file.exists);
  if (legacyFiles.length === 0) {
    return;
  }

  if (!prompter.shouldRepair) {
    note(
      [
        "Legacy sandbox registry files detected.",
        ...legacyFiles.map(formatLegacyRegistryInspectionLine),
        `Run ${formatCliCommand("openclaw doctor --fix")} to migrate them to sharded registry files.`,
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

export function noteSandboxScopeWarnings(cfg: OpenClawConfig) {
  const globalSandbox = cfg.agents?.defaults?.sandbox;
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const warnings: string[] = [];

  for (const agent of agents) {
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
        `- agents.list (id "${agentId}") sandbox ${overrides.join("/")} overrides ignored.`,
        `  scope resolves to "shared".`,
      ].join("\n"),
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}

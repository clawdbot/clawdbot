import fs from "node:fs";
import path from "node:path";

import { note } from "@clack/prompts";

import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import type { ClawdbotConfig } from "../config/config.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { replaceModernName } from "./doctor-legacy-config.js";
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
  prompter: DoctorPrompter,
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
    const build = await prompter.confirmSkipInNonInteractive({
      message: `Build ${params.label} sandbox image now?`,
      initialValue: true,
    });
    if (build) {
      built = await runSandboxScript(params.buildScript, runtime);
    }
  }

  if (built) return;

  const legacyImage = replaceModernName(params.image);
  if (!legacyImage || legacyImage === params.image) return;
  const legacyExists = await dockerImageExists(legacyImage);
  if (!legacyExists) return;

  const fallback = await prompter.confirmSkipInNonInteractive({
    message: `Switch config to legacy image ${legacyImage}?`,
    initialValue: false,
  });
  if (!fallback) return;

  params.updateConfig(legacyImage);
}

export async function maybeRepairSandboxImages(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
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
    prompter,
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
      prompter,
    );
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }

  return next;
}

export function noteSandboxScopeWarnings(cfg: ClawdbotConfig) {
  const globalSandbox = cfg.agent?.sandbox;
  const agents = cfg.routing?.agents ?? {};
  const warnings: string[] = [];

  for (const [agentId, agent] of Object.entries(agents)) {
    const agentSandbox = agent.sandbox;
    if (!agentSandbox) continue;

    const scope = resolveSandboxScope({
      scope: agentSandbox.scope ?? globalSandbox?.scope,
      perSession: agentSandbox.perSession ?? globalSandbox?.perSession,
    });

    if (scope !== "shared") continue;

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

    if (overrides.length === 0) continue;

    warnings.push(
      `- routing.agents.${agentId}.sandbox: ${overrides.join(
        "/",
      )} overrides ignored (scope resolves to "shared").`,
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}

// Shared test fixtures for container lifecycle suites. These keep the suites'
// distinct configs and fake Docker/Podman process behavior unchanged.
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { SandboxConfig } from "./types.js";

export type ContainerSpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
  envFileContents?: string;
};

type ContainerSpawnState = {
  calls: ContainerSpawnCall[];
  containerExists: boolean;
  inspectRunning: boolean;
  inspectError: string;
  labelHash: string;
  podmanInfo: string;
  podmanConnections: string;
  podmanMachines: string;
  beforeStart?: () => void;
};

type ContainerProcessResponse = { code?: number; stdout?: string; stderr?: string };

type ContainerResponseRule = {
  matches: boolean;
  run: () => ContainerProcessResponse;
};

/** Podman accepts connection options before its subcommand, in flag/value pairs. */
function podmanGlobalArgumentCount(args: readonly string[], offset = 0): number {
  return args[offset] === "--url" || args[offset] === "--identity"
    ? podmanGlobalArgumentCount(args, offset + 2)
    : offset;
}

function readContainerInvocation(commandAndArgs: string[]) {
  const [command = "", ...rawArgs] = commandAndArgs;
  const globalArgumentCount = command === "podman" ? podmanGlobalArgumentCount(rawArgs) : 0;
  return {
    command,
    args: rawArgs.slice(globalArgumentCount),
    globalArgs: rawArgs.slice(0, globalArgumentCount),
  };
}

export async function spawnContainerProcess(
  spawnState: ContainerSpawnState,
  commandAndArgs: string[],
) {
  const { command, args, globalArgs } = readContainerInvocation(commandAndArgs);
  // The tests assert docker CLI arguments without requiring Docker; this mock
  // implements only the inspect/create/start/rm calls used by ensureSandboxContainer.
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  const call: ContainerSpawnCall = { command, args, globalArgs };
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  const inspectRunning =
    args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}";
  const inspectLabel =
    args[0] === "inspect" &&
    args[1] === "-f" &&
    Boolean(args[2]?.includes('index .Config.Labels "openclaw.configHash"'));
  const rejectUnsupportedEngine: ContainerResponseRule = {
    matches: command !== "docker" && command !== "podman",
    run: () => ({ code: 1, stderr: `unexpected command: ${command}` }),
  };
  const reportInspectionFailure: ContainerResponseRule = {
    matches: inspectRunning && Boolean(spawnState.inspectError),
    run: () => ({ code: 125, stderr: spawnState.inspectError }),
  };
  const reportMissingContainer: ContainerResponseRule = {
    matches: (inspectRunning || inspectLabel) && !spawnState.containerExists,
    run: () => ({ code: 1, stderr: "No such object" }),
  };
  const reportRunningState: ContainerResponseRule = {
    matches: inspectRunning,
    run: () => ({ stdout: spawnState.inspectRunning ? "true\n" : "false\n" }),
  };
  const reportConfigHash: ContainerResponseRule = {
    matches: inspectLabel,
    run: () => ({ stdout: `${spawnState.labelHash}\n` }),
  };
  const reportPodmanInfo: ContainerResponseRule = {
    matches: command === "podman" && args[0] === "info",
    run: () => ({ stdout: spawnState.podmanInfo }),
  };
  const reportPodmanConnections: ContainerResponseRule = {
    matches: command === "podman" && args[0] === "system",
    run: () => ({ stdout: spawnState.podmanConnections }),
  };
  const reportPodmanMachines: ContainerResponseRule = {
    matches: command === "podman" && args[0] === "machine",
    run: () => ({ stdout: spawnState.podmanMachines }),
  };
  const removeContainer: ContainerResponseRule = {
    matches: args[0] === "rm" && args[1] === "-f",
    run: () => {
      spawnState.containerExists = false;
      spawnState.inspectRunning = false;
      return {};
    },
  };
  const acceptImageInspectionOrExec: ContainerResponseRule = {
    matches: (args[0] === "image" && args[1] === "inspect") || args[0] === "exec",
    run: () => ({}),
  };
  const rejectDuplicateContainer: ContainerResponseRule = {
    matches: args[0] === "create" && spawnState.containerExists,
    run: () => ({ code: 1, stderr: "container name is already in use" }),
  };
  const createContainer: ContainerResponseRule = {
    matches: args[0] === "create",
    run: () => {
      spawnState.containerExists = true;
      spawnState.inspectRunning = false;
      spawnState.labelHash =
        args
          .find((arg) => arg.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length) ?? "";
      return {};
    },
  };
  const startContainer: ContainerResponseRule = {
    matches: args[0] === "start",
    run: () => {
      spawnState.beforeStart?.();
      spawnState.inspectRunning = true;
      return {};
    },
  };
  const handlers = [
    rejectUnsupportedEngine,
    reportInspectionFailure,
    reportMissingContainer,
    reportRunningState,
    reportConfigHash,
    reportPodmanInfo,
    reportPodmanConnections,
    reportPodmanMachines,
    removeContainer,
    acceptImageInspectionOrExec,
    rejectDuplicateContainer,
    createContainer,
    startContainer,
  ];
  // First-match dispatch keeps errors ahead of state changes; only the selected handler runs.
  const {
    code = 0,
    stdout = "",
    stderr = "",
  } = handlers.find(({ matches }) => matches)?.run() ?? {
    code: 1,
    stderr: `unexpected docker args: ${args.join(" ")}`,
  };
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

export function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

export function createBrowserSandboxConfig(noVncEnabled: boolean): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: true,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: false,
      noVncEnabled,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
  };
}

/** Observe actual host mountpoints at every engine start, including stopped reuse. */
export function managedSkillMountLifecycle(options: {
  backend: "docker" | "podman";
  layout: "workspace" | "ancestor" | "deep";
  makeTempDir: (prefix: string) => string;
  spawnState: ContainerSpawnState;
  ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;
  engine?: import("./docker.js").SandboxContainerEngine;
}) {
  const { backend, layout, spawnState, ensureSandboxContainer } = options;
  const workspaceDir = fs.realpathSync(options.makeTempDir("openclaw-docker-mounts-"));
  const skillsWorkspaceDir = fs.realpathSync(options.makeTempDir("openclaw-docker-skills-"));
  const skillsDir = path.join(skillsWorkspaceDir, "skills");
  fs.mkdirSync(skillsDir);
  const custom = layout !== "workspace";
  const backingDir = custom ? path.join(workspaceDir, "custom") : workspaceDir;
  if (custom) {
    fs.mkdirSync(backingDir);
  }
  const containerTarget =
    layout === "deep" ? "/workspace/.openclaw/sandbox-skills" : "/workspace/.openclaw";
  const cfg = {
    ...createSandboxConfig([], custom ? [`${backingDir}:${containerTarget}:rw`] : []),
    backend,
  };
  const attachment = path.join(workspaceDir, ".openclaw");
  const skillsParent =
    layout === "ancestor"
      ? path.join(backingDir, "sandbox-skills")
      : path.join(attachment, "sandbox-skills");
  const overlayTarget =
    layout === "deep" ? path.join(backingDir, "skills") : path.join(skillsParent, "skills");
  const params = {
    scopeKey: "shared",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    skillsWorkspaceDir,
    cfg,
    engine: options.engine,
  };
  spawnState.containerExists = false;
  return {
    start: () => ensureSandboxContainer(params),
    expectHostOwnedMountpointsBeforeEveryStart() {
      spawnState.beforeStart = () => {
        for (const target of [attachment, skillsParent, overlayTarget]) {
          expect(fs.existsSync(target)).toBe(true);
          const stat = fs.lstatSync(target);
          expect(stat.isDirectory()).toBe(true);
          expect(stat.uid).toBe(fs.statSync(workspaceDir).uid);
        }
      };
    },
    expectReadOnlySkillMount() {
      const createCall = spawnState.calls.find((call) => call.args[0] === "create");
      expect(createCall?.args).toContain(
        `${skillsDir}:/workspace/.openclaw/sandbox-skills/skills:ro,z`,
      );
    },
    stopAndRemoveMountpoints() {
      fs.rmSync(attachment, { recursive: true });
      if (custom) {
        fs.rmSync(layout === "deep" ? overlayTarget : skillsParent, { recursive: true });
      }
      spawnState.inspectRunning = false;
    },
    expectOneCreationAndTwoStarts() {
      expect(spawnState.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
      expect(spawnState.calls.filter((call) => call.args[0] === "start")).toHaveLength(2);
    },
    expectWorkspaceCleanupPreservesSkills() {
      fs.rmSync(workspaceDir, { recursive: true });
      expect(fs.existsSync(workspaceDir)).toBe(false);
      expect(fs.statSync(skillsDir).isDirectory()).toBe(true);
    },
  };
}

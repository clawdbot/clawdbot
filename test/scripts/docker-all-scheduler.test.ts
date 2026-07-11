// Docker All Scheduler tests cover docker all scheduler script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_RESOURCE_LIMITS } from "../../scripts/lib/docker-e2e-plan.mjs";
import {
  appendBoundedShellCapture,
  canStartSchedulerLane,
  describeDockerSchedulerLimits,
  dockerPreflightContainerNames,
  dockerPreflightSmokeCommand,
  githubWorkflowRerunCommand,
  LOG_TAIL_MAX_BYTES,
  parseDockerAllCliArgs,
  resolveDockerPreflightPlatform,
  runCleanupSmokePhase,
  runShellCaptureCommand,
  runShellCommand,
  SHELL_CAPTURE_MAX_CHARS,
  tailFile,
  writeRunSummary,
} from "../../scripts/test-docker-all.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const limits = {
  resourceLimits: {
    docker: 2,
    npm: 2,
  },
  weightLimit: 2,
};
const posixIt = process.platform === "win32" ? it.skip : it;
const { createTempDir } = createScriptTestHarness();
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";

function expectDeclaredDispatchInputs(command: string): void {
  const workflow = parse(readFileSync(LIVE_E2E_WORKFLOW, "utf8")) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  };
  const declared = new Set(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {}));
  const emitted = [...command.matchAll(/(?:^|\s)-f\s+([a-z0-9_]+)=/gu)].map((match) => match[1]);
  expect(emitted.length).toBeGreaterThan(0);
  for (const input of emitted) {
    expect(declared.has(input), `undeclared workflow_dispatch input: ${input}`).toBe(true);
  }
}

function activePool({
  count = 0,
  resources = {},
  weight = 0,
}: {
  count?: number;
  resources?: Record<string, number>;
  weight?: number;
} = {}) {
  return {
    count,
    resources: new Map(Object.entries(resources)),
    weight,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error("condition was not met before timeout");
}

async function waitForChildClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("child did not close before timeout"));
      }, timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );
}

describe("scripts/test-docker-all scheduler", () => {
  it("parses the supported CLI options", () => {
    expect(parseDockerAllCliArgs([])).toEqual({
      help: false,
      planJson: false,
    });
    expect(parseDockerAllCliArgs(["--plan-json"])).toEqual({
      help: false,
      planJson: true,
    });
    expect(parseDockerAllCliArgs(["--help"])).toEqual({
      help: true,
      planJson: false,
    });
  });

  it("prints CLI help without a stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/test-docker-all.mjs [--plan-json]");
    expect(result.stdout).toContain("OPENCLAW_DOCKER_ALL_* env vars");
  });

  it("rejects unknown CLI options without a stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", "--bogus"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("Usage: node scripts/test-docker-all.mjs [--plan-json]");
    expect(result.stderr).not.toContain("at ");
  });

  it("rejects loose numeric runner env vars without a stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs", "--plan-json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_PARALLELISM: "1e3",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENCLAW_DOCKER_ALL_PARALLELISM must be a positive integer");
    expect(result.stderr).not.toContain("at ");
  });

  it("reuses only registry-backed images in generated workflow reruns", () => {
    const localCommand = githubWorkflowRerunCommand(["install-e2e"], "a".repeat(40), {
      GITHUB_REF_NAME: "full-release-validation-temp-deleted",
      GITHUB_RUN_ID: "12345",
      OPENCLAW_DOCKER_E2E_BARE_IMAGE: "openclaw-docker-e2e-bare:local",
      OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE: "openclaw-docker-e2e-functional:local",
      OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME: "docker-e2e-package",
    });
    expect(localCommand).not.toContain("--ref 'full-release-validation-temp-deleted'");
    expect(localCommand).not.toContain("package_artifact_run_id=");
    expect(localCommand).not.toContain("package_artifact_name=");
    expect(localCommand).not.toContain("docker_e2e_bare_image=");
    expect(localCommand).not.toContain("docker_e2e_functional_image=");
    expect(localCommand).not.toContain("shared_image_policy=existing-only");
    expectDeclaredDispatchInputs(localCommand);

    const registryCommand = githubWorkflowRerunCommand(["install-e2e"], "b".repeat(40), {
      OPENCLAW_DOCKER_E2E_BARE_IMAGE: "ghcr.io/openclaw/openclaw-docker-e2e-bare:test",
      OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE: "ghcr.io/openclaw/openclaw-docker-e2e-functional:test",
      OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "true",
      OPENCLAW_DOCKER_E2E_WORKFLOW_REF: "main",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.5.3",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "openclaw@2026.5.3 openclaw@2026.5.2",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "plugin-dependency-cleanup",
    });
    expect(registryCommand).toContain("--ref 'main'");
    expect(registryCommand).toContain(
      "docker_e2e_bare_image='ghcr.io/openclaw/openclaw-docker-e2e-bare:test'",
    );
    expect(registryCommand).toContain(
      "docker_e2e_functional_image='ghcr.io/openclaw/openclaw-docker-e2e-functional:test'",
    );
    expect(registryCommand).toContain("shared_image_policy=existing-only");
    expect(registryCommand).toContain("allow_unreleased_changelog=true");
    expectDeclaredDispatchInputs(registryCommand);
  });

  it("preserves ephemeral package intent in generated summary and failure reruns", async () => {
    const logDir = createTempDir("openclaw-docker-all-rerun-intent-");
    try {
      const selectedSha = "c".repeat(40);
      await writeRunSummary(
        logDir,
        {
          failures: [{ name: "install-e2e", status: 1 }],
          lanes: [],
          status: "failed",
        },
        {
          ...process.env,
          OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG: "true",
          OPENCLAW_DOCKER_E2E_SELECTED_SHA: selectedSha,
        },
      );

      const summaryFile = path.join(logDir, "summary.json");
      const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
      expect(summary.allowUnreleasedChangelog).toBe(true);

      const failureIndexFile = path.join(logDir, "failures.json");
      const failureIndex = JSON.parse(readFileSync(failureIndexFile, "utf8"));
      expect(failureIndex.combinedGhWorkflowCommand).toContain("allow_unreleased_changelog=true");

      for (const artifact of [summaryFile, failureIndexFile]) {
        const rerun = spawnSync(process.execPath, ["scripts/docker-e2e-rerun.mjs", artifact], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: process.env,
        });
        expect(rerun.status, rerun.stderr).toBe(0);
        expect(rerun.stdout).toContain(`-f ref='${selectedSha}'`);
        expect(rerun.stdout).toContain("allow_unreleased_changelog=true");
      }
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it("rejects loose numeric resource limit env vars before scheduling lanes", () => {
    const logDir = mkdtempSync(`${tmpdir()}/openclaw-docker-all-`);
    try {
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_ALL_BUILD: "0",
          OPENCLAW_DOCKER_ALL_DOCKER_LIMIT: "1e3",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "OPENCLAW_DOCKER_ALL_DOCKER_LIMIT must be a positive integer",
      );
      expect(result.stderr).not.toContain("at ");
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  it("rejects release-path configs that schedule zero Docker lanes", () => {
    const logDir = mkdtempSync(`${tmpdir()}/openclaw-docker-all-`);
    try {
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_DOCKER_ALL_CHUNK: "openwebui",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
          OPENCLAW_DOCKER_ALL_INCLUDE_OPENWEBUI: "0",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
          OPENCLAW_DOCKER_ALL_PROFILE: "release-path",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("Dry run complete");
      expect(result.stderr).toContain("resolved zero Docker lanes");
      expect(result.stderr).toContain("profile=release-path");
      expect(result.stderr).toContain("releaseChunk=openwebui");
      expect(result.stderr).toContain("includeOpenWebUI=0");
      expect(result.stderr).not.toContain("at ");
    } finally {
      rmSync(logDir, { force: true, recursive: true });
    }
  });

  posixIt("writes Docker run artifacts when cleanup smoke fails", async () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-all-cleanup-`);
    const logDir = path.join(root, "logs");
    const fakePnpm = path.join(root, "pnpm");
    const phases: Array<Record<string, unknown>> = [];
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env node
const command = process.argv.slice(2).join(" ");
if (command === "test:docker:cleanup") {
  console.error("cleanup smoke failed intentionally");
  process.exit(42);
}
process.exit(0);
`,
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    try {
      const baseEnv = {
        ...process.env,
        OPENCLAW_DOCKER_E2E_IMAGE: "openclaw-test-image",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const cleanupFailure = await runCleanupSmokePhase(baseEnv, logDir, phases);
      expect(cleanupFailure).toMatchObject({ name: "cleanup-smoke", status: 42 });
      if (!cleanupFailure) {
        throw new Error("expected cleanup smoke failure");
      }
      await writeRunSummary(logDir, {
        failures: [cleanupFailure],
        image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
        images: {
          bare: "openclaw-test-bare",
          functional: "openclaw-test-image",
        },
        lanes: [],
        phases,
        profile: "local",
        startedAt: new Date().toISOString(),
        status: "failed",
      });

      const summary = JSON.parse(readFileSync(path.join(logDir, "summary.json"), "utf8"));
      expect(summary.status).toBe("failed");
      expect(summary.failures).toHaveLength(1);
      expect(summary.failures[0]).toMatchObject({
        name: "cleanup-smoke",
        rerunCommand: "pnpm test:docker:cleanup",
        status: 42,
        targetable: false,
      });
      expect(summary.lanes.some((lane: { name?: string }) => lane.name === "cleanup-smoke")).toBe(
        false,
      );
      expect(summary.phases.at(-1)).toMatchObject({
        name: "cleanup-smoke",
        status: "failed",
      });

      const failureIndex = JSON.parse(readFileSync(path.join(logDir, "failures.json"), "utf8"));
      expect(failureIndex.status).toBe("failed");
      expect(failureIndex.combinedGhWorkflowCommand).toBeUndefined();
      expect(failureIndex.lanes[0]?.ghWorkflowCommand).toBeUndefined();
      expect(failureIndex.lanes).toEqual([
        expect.objectContaining({
          lane: "cleanup-smoke",
          rerunCommand: "pnpm test:docker:cleanup",
          status: 42,
          targetable: false,
        }),
      ]);
      const cleanupLog = readFileSync(path.join(logDir, "cleanup-smoke.log"), "utf8");
      expect(cleanupLog).toContain("cleanup smoke failed intentionally");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("allows an overweight lane to start alone under low parallelism", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "install-e2e",
          resources: ["npm"],
          weight: 4,
        },
        activePool(),
        2,
        limits,
      ),
    ).toBe(true);
  });

  it("does not co-schedule another lane while an overweight lane is active", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "package-update",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 1,
          resources: {
            docker: 4,
            npm: 4,
          },
          weight: 4,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("can co-schedule the split installer provider lanes", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "install-e2e-anthropic",
          resources: ["npm", "service"],
          weight: 3,
        },
        activePool({
          count: 1,
          resources: {
            docker: 3,
            npm: 3,
            service: 3,
          },
          weight: 3,
        }),
        10,
        {
          resourceLimits: {
            docker: 10,
            npm: 10,
            service: 7,
          },
          weightLimit: 10,
        },
      ),
    ).toBe(true);
  });

  it("preserves the parallelism count cap", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "package-update",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 2,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("keeps resource and weight limits as co-scheduling limits", () => {
    expect(
      canStartSchedulerLane(
        {
          name: "npm-smoke",
          resources: ["npm"],
          weight: 1,
        },
        activePool({
          count: 1,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(true);

    expect(
      canStartSchedulerLane(
        {
          name: "npm-heavy",
          resources: ["npm"],
          weight: 2,
        },
        activePool({
          count: 1,
          resources: {
            docker: 1,
            npm: 1,
          },
          weight: 1,
        }),
        2,
        limits,
      ),
    ).toBe(false);
  });

  it("serializes live OpenAI Docker lanes by default", () => {
    expect(DEFAULT_RESOURCE_LIMITS["live:openai"]).toBe(1);
  });

  it("caps npm-heavy Docker lanes below full parallelism by default", () => {
    expect(DEFAULT_RESOURCE_LIMITS.npm).toBe(5);
  });

  it("cleans stale stopped containers from all named Docker E2E lanes", () => {
    expect(
      dockerPreflightContainerNames(`
openclaw-gateway-e2e-123 Exited (1) 2 minutes ago
openclaw-config-reload-e2e-234 Created
openclaw-plugin-binding-command-escape-e2e-345 Dead
openclaw-kitchen-sink-rpc-e2e-456 Exited (137) 10 seconds ago
openclaw-openwebui-gateway-567 Exited (1) 3 minutes ago
openclaw-openwebui-678 Created
openclaw-not-an-e2e-container Exited (1) 2 minutes ago
postgres Created
`),
    ).toEqual([
      "openclaw-gateway-e2e-123",
      "openclaw-config-reload-e2e-234",
      "openclaw-plugin-binding-command-escape-e2e-345",
      "openclaw-kitchen-sink-rpc-e2e-456",
      "openclaw-openwebui-gateway-567",
      "openclaw-openwebui-678",
    ]);
  });

  it("pins Docker preflight smoke to the native platform", () => {
    expect(resolveDockerPreflightPlatform("x64")).toBe("linux/amd64");
    expect(resolveDockerPreflightPlatform("arm64")).toBe("linux/arm64");
    expect(dockerPreflightSmokeCommand("x64")).toBe(
      "docker run --rm --platform 'linux/amd64' alpine:3.20 true",
    );
    expect(dockerPreflightSmokeCommand("arm64")).toBe(
      "docker run --rm --platform 'linux/arm64' alpine:3.20 true",
    );
  });

  it("bounds captured preflight command output while keeping the newest tail", () => {
    const first = appendBoundedShellCapture("abc", "def", 8);
    expect(first).toEqual({ text: "abcdef", truncated: false });

    const second = appendBoundedShellCapture(first.text, "ghijkl", 8);
    expect(second).toEqual({ text: "efghijkl", truncated: true });
    expect(SHELL_CAPTURE_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("reads bounded lane log tails instead of full noisy logs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-all-log-tail-"));
    try {
      const logPath = path.join(root, "lane.log");
      writeFileSync(
        logPath,
        `old-secret\n${"x".repeat(LOG_TAIL_MAX_BYTES + 1024)}\nrecent failure\n`,
        "utf8",
      );

      const tail = await tailFile(logPath, 2);

      expect(tail).toContain("recent failure");
      expect(tail).not.toContain("old-secret");
      expect(tail.length).toBeLessThan(LOG_TAIL_MAX_BYTES);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("clamps oversized shell command timers before scheduling", async () => {
    const result = await runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 25);",
      )}`,
      env: process.env,
      label: "oversized-command-timeout",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toMatchObject({
      noOutputTimedOut: false,
      status: 0,
      timedOut: false,
    });
  });

  posixIt("clamps oversized shell command no-output timers before scheduling", async () => {
    const result = await runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 25);",
      )}`,
      env: process.env,
      label: "oversized-no-output-timeout",
      noOutputTimeoutMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      noOutputTimedOut: false,
      status: 0,
      timedOut: false,
    });
  });

  posixIt("clamps oversized shell capture timers before scheduling", async () => {
    const result = await runShellCaptureCommand({
      command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "setTimeout(() => process.exit(0), 25);",
      )}`,
      env: process.env,
      label: "oversized-capture-timeout",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toMatchObject({
      status: 0,
      timedOut: false,
    });
  });

  posixIt("kills timed-out shell command groups when the leader exits first", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-all-timeout-"));
    const scriptPath = path.join(root, "leader-exits.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let grandchildPid = 0;

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    try {
      const runPromise = runShellCommand({
        command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(
          scriptPath,
        )} ${JSON.stringify(grandchildPidPath)}`,
        env: process.env,
        label: "timeout-leader-exits",
        timeoutKillGraceMs: 25,
        timeoutMs: 250,
      });

      await waitFor(() => existsSync(grandchildPidPath));
      grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await expect(runPromise).resolves.toMatchObject({ timedOut: true });
      await waitFor(() => !isProcessAlive(grandchildPid));
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("clamps oversized shell command kill grace before scheduling", async () => {
    const root = createTempDir("openclaw-docker-all-oversized-grace-");
    const scriptPath = path.join(root, "leader-exits.mjs");
    const donePath = path.join(root, "done");
    const readyPath = path.join(root, "ready");
    const childScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const result = await runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      env: process.env,
      label: "oversized-timeout-grace",
      timeoutKillGraceMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("lets timed-out shell command descendants exit during kill grace", async () => {
    const root = createTempDir("openclaw-docker-all-grace-");
    const scriptPath = path.join(root, "leader-exits.mjs");
    const donePath = path.join(root, "done");
    const readyPath = path.join(root, "ready");
    const childScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runShellCommand({
      command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      env: process.env,
      label: "timeout-grace",
      timeoutKillGraceMs: 500,
      timeoutMs: 500,
    });

    await waitFor(() => existsSync(readyPath));
    const result = await runPromise;
    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("lets timed-out shell capture descendants exit during kill grace", async () => {
    const root = createTempDir("openclaw-docker-all-capture-grace-");
    const scriptPath = path.join(root, "leader-exits.mjs");
    const donePath = path.join(root, "done");
    const readyPath = path.join(root, "ready");
    const childScript = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runShellCaptureCommand({
      command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      env: process.env,
      label: "capture-timeout-grace",
      timeoutKillGraceMs: 500,
      timeoutMs: 500,
    });

    await waitFor(() => existsSync(readyPath));
    const result = await runPromise;
    expect(result).toMatchObject({ timedOut: true });
    expect(readFileSync(donePath, "utf8")).toBe("done");
  });

  posixIt("cleans active shell command groups before parent signal exit", async () => {
    const root = createTempDir("openclaw-docker-all-parent-signal-");
    const leaderPath = path.join(root, "leader-exits.mjs");
    const runnerPath = path.join(root, "runner.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const readyPath = path.join(root, "ready");
    const secondGrandchildPidPath = path.join(root, "second-grandchild.pid");
    const secondReadyPath = path.join(root, "second-ready");
    let grandchildPid = 0;
    let secondGrandchildPid = 0;
    let runner: ReturnType<typeof spawn> | undefined;
    const childScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGHUP', () => {});",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      leaderPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
  stdio: "ignore",
});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    // Preserve the production 10s grace while accelerating only this spawned proof's clock.
    writeFileSync(
      runnerPath,
      `
const realNow = Date.now.bind(Date);
const startedAt = realNow();
Date.now = () => startedAt + (realNow() - startedAt) * 100;

const { runShellCommand } = await import(${JSON.stringify(
        new URL("../../scripts/test-docker-all.mjs", import.meta.url).href,
      )});

await runShellCommand({
  command: ${JSON.stringify(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(leaderPath)}`)},
  env: process.env,
  label: "parent-signal-cleanup",
  timeoutKillGraceMs: 100,
  timeoutMs: 30_000,
});

await runShellCommand({
  command: ${JSON.stringify(
    [
      "exec",
      JSON.stringify(process.execPath),
      "-e",
      JSON.stringify(
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
          `fs.writeFileSync(${JSON.stringify(secondGrandchildPidPath)}, String(child.pid));`,
          `fs.writeFileSync(${JSON.stringify(secondReadyPath)}, 'ready');`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ),
    ].join(" "),
  )},
  env: process.env,
  label: "parent-signal-second-command",
  timeoutKillGraceMs: 100,
  timeoutMs: 30_000,
});
`,
      "utf8",
    );

    try {
      runner = spawn(process.execPath, [runnerPath], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      await waitFor(() => existsSync(readyPath) && existsSync(grandchildPidPath));
      grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      runner.kill("SIGTERM");

      await expect(waitForChildClose(runner, 15_000)).resolves.toEqual({
        code: 143,
        signal: null,
      });
      await waitFor(() => !isProcessAlive(grandchildPid));
      expect(existsSync(secondReadyPath)).toBe(false);
      if (existsSync(secondGrandchildPidPath)) {
        secondGrandchildPid = Number.parseInt(readFileSync(secondGrandchildPidPath, "utf8"), 10);
      }
      expect(secondGrandchildPid).toBe(0);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      if (secondGrandchildPid && isProcessAlive(secondGrandchildPid)) {
        process.kill(secondGrandchildPid, "SIGKILL");
      }
      if (runner?.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGKILL");
      }
    }
  });

  it("describes effective scheduler limits for operator errors", () => {
    expect(describeDockerSchedulerLimits(2, limits)).toBe(
      "parallelism=2 weightLimit=2 resources=docker=2 npm=2",
    );
  });
});

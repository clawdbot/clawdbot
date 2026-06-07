// Docker All Scheduler tests cover docker all scheduler script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_RESOURCE_LIMITS } from "../../scripts/lib/docker-e2e-plan.mjs";
import {
  appendBoundedShellCapture,
  canStartSchedulerLane,
  describeDockerSchedulerLimits,
  dockerPreflightContainerNames,
  LOG_TAIL_MAX_BYTES,
  parseDockerAllCliArgs,
  runShellCommand,
  SHELL_CAPTURE_MAX_CHARS,
  tailFile,
} from "../../scripts/test-docker-all.mjs";

const limits = {
  resourceLimits: {
    docker: 2,
    npm: 2,
  },
  weightLimit: 2,
};
const posixIt = process.platform === "win32" ? it.skip : it;

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

  posixIt("writes Docker run artifacts when cleanup smoke fails", () => {
    const root = mkdtempSync(`${tmpdir()}/openclaw-docker-all-cleanup-`);
    const logDir = path.join(root, "logs");
    const packageTgz = path.join(root, "openclaw-current.tgz");
    const fakePnpm = path.join(root, "pnpm");
    writeFileSync(packageTgz, "fake package\n", "utf8");
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
      const result = spawnSync(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz,
          OPENCLAW_DOCKER_ALL_BUILD: "0",
          OPENCLAW_DOCKER_ALL_LIVE_MODE: "skip",
          OPENCLAW_DOCKER_ALL_LOG_DIR: logDir,
          OPENCLAW_DOCKER_ALL_PARALLELISM: "16",
          OPENCLAW_DOCKER_ALL_PREFLIGHT: "0",
          OPENCLAW_DOCKER_ALL_START_STAGGER_MS: "0",
          OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS: "0",
          OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM: "16",
          OPENCLAW_DOCKER_ALL_TIMINGS: "0",
          PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cleanup smoke failed intentionally");

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
        timeoutMs: 1_000,
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

  it("describes effective scheduler limits for operator errors", () => {
    expect(describeDockerSchedulerLimits(2, limits)).toBe(
      "parallelism=2 weightLimit=2 resources=docker=2 npm=2",
    );
  });
});

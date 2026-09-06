import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
} from "./update-post-core-context.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshot: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/exec.js", () => ({ runCommandBuffered: mocks.snapshot }));
vi.mock("../process/kill-tree.js", () => ({ signalProcessTree: mocks.signal }));

class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

let root: string;
let nextPid = 41_000;
const children = new Map<number, FakeChild>();
let candidateConfig: Record<string, unknown>;
let childEnv: NodeJS.ProcessEnv;
let pluginErrors = false;
let runtimeError = false;
let runtimeContract: unknown;

beforeEach(async () => {
  vi.clearAllMocks();
  pluginErrors = false;
  runtimeError = false;
  runtimeContract = { state: 2, agent: 3 };
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "canary-unit-")));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.mkdir(path.join(root, "dist", "infra"));
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  mocks.snapshot.mockResolvedValue({
    code: 0,
    stdout: Buffer.from("[]"),
    stderr: Buffer.alloc(0),
    termination: "exit",
  });
  mocks.spawn.mockImplementation(
    (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      childEnv = options.env;
      if (args.includes("gateway")) {
        void fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8").then((raw) => {
          candidateConfig = JSON.parse(raw) as Record<string, unknown>;
        });
      } else {
        queueMicrotask(() => {
          if (args.includes("plugins")) {
            child.stdout.write(
              JSON.stringify({
                plugins: [],
                diagnostics: pluginErrors
                  ? [{ level: "error", message: "incompatible plugin" }]
                  : [],
              }),
            );
          }
          if (args.includes("--check")) {
            child.stdout.write(JSON.stringify(runtimeContract));
          }
          child.emit("close", runtimeError && args.includes("--check") ? 1 : 0);
        });
      }
      return child;
    },
  );
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  children.clear();
  await fs.rm(root, { recursive: true, force: true });
});

describe("update candidate canary", () => {
  it("reports unavailable validation when the candidate predates the migration-continuation contract", async () => {
    await fs.rm(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "started", ready: true })),
    );
    const onStep = vi.fn();
    const result = await validateUpdateCandidateCanary({
      root,
      stateDir: root,
      config: {},
      env: {},
      timeoutMs: 3_000,
      onStep,
    });
    expect(result).toMatchObject({ status: "ok", phase: "runtime" });
    expect(result.candidateSchemaVersions).toBeUndefined();
    expect(result.steps).toEqual([
      expect.objectContaining({
        name: "candidate migration continuation",
        exitCode: null,
        stdoutTail:
          "candidate predates the migration-continuation contract; finalization runs in the current binary",
      }),
    ]);
    expect(onStep).toHaveBeenCalledWith(result.steps[0]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rehearses and validates only private state before requiring started then ready, and reaps the process group", async () => {
    const requests: string[] = [];
    const completed: Array<{ name: string; argv: string[] }> = [];
    let startupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(new URL(url).pathname);
        if (url.endsWith("startupz")) {
          startupCalls += 1;
          return Response.json({ status: startupCalls === 1 ? "starting" : "started" });
        }
        return Response.json({ ready: true });
      }),
    );
    const original = {
      gateway: { port: 18789 },
      cron: { enabled: true },
      agents: {
        entries: { main: { workspace: "/original/workspace", agentDir: "/original/agent" } },
      },
    };
    const result = await validateUpdateCandidateCanary({
      root,
      stateDir: root,
      config: original,
      env: {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: path.join(root, "live-sentinel.json"),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: path.join(root, "live-result.json"),
        [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: path.join(root, "live-config.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        OPENCLAW_SYSTEMD_UNIT: "source-gateway.service",
        CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
      },
      timeoutMs: 3_000,
      onStep: (step) => {
        completed.push({ name: step.name, argv: [...mocks.spawn.mock.calls.at(-1)![1]] });
      },
    });
    expect(result.status).toBe("ok");
    expect(result.candidateSchemaVersions).toEqual({ state: 2, agent: 3 });
    expect(result.steps.map((step) => step.name)).toEqual([
      "candidate migration rehearsal",
      "candidate doctor lint",
      "candidate config validation",
      "candidate plugin resolution",
      "candidate migration continuation",
      "candidate gateway canary",
    ]);
    expect(completed.map((step) => step.name)).toEqual(result.steps.map((step) => step.name));
    expect(completed.map((step) => step.argv.slice(1, 3))).toEqual([
      ["doctor", "--fix"],
      ["doctor", "--lint"],
      ["config", "validate"],
      ["plugins", "list"],
      ["--check"],
      ["gateway", "run"],
    ]);
    expect(requests).toEqual(["/startupz", "/startupz", "/readyz"]);
    expect(childEnv.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(childEnv).toMatchObject({
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
    });
    for (const key of [
      CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
      POST_CORE_UPDATE_RESULT_PATH_ENV,
      POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_SYSTEMD_UNIT",
    ]) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(mocks.spawn.mock.calls.find(([, args]) => args.includes("--check"))?.[1]).toEqual([
      path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "--check",
    ]);
    expect(candidateConfig).toMatchObject({
      cron: { enabled: false },
      gateway: { bind: "loopback" },
    });
    expect(original.cron.enabled).toBe(true);
    const gatewayPid = [...children.keys()].at(-1)!;
    expect(
      mocks.signal.mock.calls.filter(([pid]) => pid === gatewayPid).map(([, signal]) => signal),
    ).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.logTail.join("\n")).toContain("startupz: started");
    await expect(fs.access(childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses caller-owned rehearsal changes across validations until the caller disposes them", async () => {
    const config: OpenClawConfig = { logging: { level: "info" } };
    const observed: Array<{ configPath: string; level: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const configPath = childEnv.OPENCLAW_CONFIG_PATH!;
        const current = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        observed.push({ configPath, level: current.logging?.level });
        return Response.json({ status: "started", ready: true });
      }),
    );
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir: root,
      env: {},
      timeoutMs: 3_000,
    });
    try {
      const first = await validateUpdateCandidateCanary({
        root,
        stateDir: root,
        config,
        env: {},
        rehearsal,
        timeoutMs: 3_000,
      });
      expect(first.status).toBe("ok");
      const copied = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8")) as OpenClawConfig;
      copied.logging = { ...copied.logging, level: "debug" };
      const repairedConfig = JSON.stringify(copied);
      await fs.writeFile(rehearsal.configPath, repairedConfig);
      const second = await validateUpdateCandidateCanary({
        root,
        stateDir: root,
        config,
        env: {},
        rehearsal,
        timeoutMs: 3_000,
      });
      expect(second.status).toBe("ok");
      expect(observed).toEqual([
        { configPath: rehearsal.configPath, level: "info" },
        { configPath: rehearsal.configPath, level: "info" },
        { configPath: rehearsal.configPath, level: "debug" },
        { configPath: rehearsal.configPath, level: "debug" },
      ]);
      expect(mocks.snapshot).toHaveBeenCalledOnce();
      expect(await fs.readFile(rehearsal.configPath, "utf8")).toBe(repairedConfig);
      await expect(fs.access(rehearsal.stateDir)).resolves.toBeUndefined();
    } finally {
      await rehearsal.cleanup();
    }
    await expect(fs.access(rehearsal.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["snapshot", "doctor", "plugins", "runtime", "readiness"] as const)(
    "records a failed %s step and cleans private state",
    async (failure) => {
      pluginErrors = failure === "plugins";
      runtimeError = failure === "runtime";
      if (failure === "snapshot") {
        mocks.snapshot.mockResolvedValue({
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("snapshot rejected"),
          termination: "exit",
        });
      }
      if (failure === "doctor") {
        mocks.spawn.mockImplementationOnce(() => {
          const child = new FakeChild(nextPid++);
          queueMicrotask(() => {
            child.stderr.write(
              Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"),
            );
            child.emit("close", 1);
          });
          return child;
        });
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json({ status: "started" }, { status: url.endsWith("readyz") ? 503 : 200 }),
        ),
      );
      const result = await validateUpdateCandidateCanary({
        root,
        stateDir: root,
        config: {},
        env: {},
        timeoutMs: 250,
      });
      expect(result.status).toBe("error");
      expect(result.phase).toBe(failure);
      if (failure === "readiness") {
        expect(result.steps.at(-1)?.name).toBe("candidate gateway canary");
      }
      expect(result.steps.some((step) => step.exitCode !== 0)).toBe(true);
      expect(result.logTail.length).toBeLessThanOrEqual(40);
      expect(result.durationMs).toBeLessThan(1_000);
      if (failure === "snapshot") {
        expect(mocks.spawn).not.toHaveBeenCalled();
      } else {
        expect(mocks.signal).toHaveBeenCalled();
      }
      const snapshotInput = JSON.parse(mocks.snapshot.mock.calls[0]![1].input) as {
        targetStateDir: string;
      };
      await expect(fs.access(snapshotInput.targetStateDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("refuses a candidate that cannot keep Doctor away from managed services", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.4.1" }));
    const result = await validateUpdateCandidateCanary({
      root,
      stateDir: root,
      config: {},
      env: {},
    });
    expect(result.status).toBe("error");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("drains a cancelled validation child before deleting its private state", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      childEnv = options.env;
      queueMicrotask(() => controller.abort(new Error("repair deadline")));
      return child;
    });
    const result = await validateUpdateCandidateCanary({
      root,
      stateDir: root,
      config: {},
      env: {},
      timeoutMs: 3_000,
      signal: controller.signal,
    });
    expect(result.status).toBe("error");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.signal.mock.calls.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(fs.access(childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a zero-exit continuation worker without its compiled schema contract before boot", async () => {
    runtimeContract = null;
    const result = await validateUpdateCandidateCanary({
      root,
      stateDir: root,
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(result.steps.at(-1)).toMatchObject({
      name: "candidate migration continuation",
      exitCode: 1,
    });
    expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("--update-canary"))).toBe(false);
  });

  it("aborts further validation and removes private state when recording a step fails", async () => {
    await expect(
      validateUpdateCandidateCanary({
        root,
        stateDir: root,
        config: {},
        env: {},
        timeoutMs: 3_000,
        onStep: () => {
          throw new Error("ledger unavailable");
        },
      }),
    ).rejects.toThrow("ledger unavailable");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const snapshotInput = JSON.parse(mocks.snapshot.mock.calls[0]![1].input) as {
      targetStateDir: string;
    };
    await expect(fs.access(snapshotInput.targetStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("omits the entire oversized log line across chunks while preserving following diagnostics", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild(nextPid++);
      queueMicrotask(() => {
        child.stderr.write("x".repeat(70_000));
        child.stderr.write("synthetic-sensitive-suffix\nfollowing-safe-line\n");
        child.emit("close", 1);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary({
      root,
      stateDir: root,
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
    expect(result.status).toBe("error");
    expect(result.logTail.join("\n")).not.toContain("synthetic-sensitive-suffix");
    expect(result.logTail).toContain("following-safe-line");
    expect(result.steps.at(-1)?.stderrTail).toContain("following-safe-line");
  });
});

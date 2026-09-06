import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withUpdateFailureTriage, type UpdateTriageTarget } from "./update-command-triage.js";

const runInteractiveUpdateFailureAction = vi.hoisted(() =>
  vi.fn<typeof import("./update-command-report.js").runInteractiveUpdateFailureAction>(
    async () => "triage" as const,
  ),
);

vi.mock("./update-command-report.js", () => ({ runInteractiveUpdateFailureAction }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const failedUpdate: UpdateRunResult = {
  status: "error",
  mode: "npm",
  reason: "global-install-failed",
  before: { version: "2026.8.1" },
  steps: [
    {
      name: "global install",
      command: "npm install",
      cwd: "/install",
      durationMs: 1,
      exitCode: 1,
      stderrTail: "ENOSPC",
    },
  ],
  durationMs: 1,
};

async function createInstalledTriage(exitCode = 0) {
  const root = await fs.realpath(tempDirs.make("openclaw-update-triage-"));
  await fs.mkdir(path.join(root, "dist"));
  // The real child consumes the failure export and environment after the caller unwinds.
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
    const fs = require("node:fs");
    const path = require("node:path");
    const args = process.argv.slice(2);
    const input = args[args.indexOf("--update-result") + 1];
    fs.writeFileSync(path.join(process.cwd(), "receipt.json"), JSON.stringify({
      args,
      failure: JSON.parse(fs.readFileSync(input, "utf8")),
      stateDir: process.env.OPENCLAW_STATE_DIR,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS,
      serviceMarker: process.env.OPENCLAW_SERVICE_MARKER,
      released: fs.existsSync(path.join(process.cwd(), "released")),
    }));
    process.stdout.write(args.includes("--json")
      ? JSON.stringify({promptPath: path.join(process.cwd(), "prompt.md"), bundlePath: null, bundleError: null}) + "\\n"
      : "triage report\\n");
    process.exitCode = ${exitCode};
  `,
  );
  return {
    root,
    nodeRunner: process.execPath,
    env: {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: path.join(root, "named-state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "custom-config.json"),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_SERVICE_MARKER: "openclaw",
    },
  } satisfies UpdateTriageTarget;
}

async function readReceipt(target: { root: string }) {
  return JSON.parse(await fs.readFile(path.join(target.root, "receipt.json"), "utf8")) as {
    args: string[];
    failure: unknown;
    stateDir: string;
    configPath: string;
    updateInProgress?: string;
    serviceMarker?: string;
    released: boolean;
  };
}

async function createManagedTriageTarget() {
  const target = await createInstalledTriage();
  const handoffDir = path.join(target.root, "handoff");
  await fs.mkdir(handoffDir, { mode: 0o700 });
  const contextPath = path.join(handoffDir, "update-failure.json");
  const metaPath = path.join(handoffDir, "sentinel-meta.json");
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      version: 1,
      meta: { handoffId: "fixture-handoff", triageContextPath: contextPath },
    }),
  );
  Object.assign(target.env, {
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
  });
  return { target, contextPath };
}

async function withTerminal(run: () => Promise<void>) {
  const streams = [process.stdin, process.stdout];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  }
  try {
    await run();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  }
}

beforeEach(() => {
  runInteractiveUpdateFailureAction.mockReset();
  runInteractiveUpdateFailureAction.mockResolvedValue("triage");
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("update failure triage boundary", () => {
  it.each([0, 7])(
    "runs the installed triage after cleanup without changing update failure (triage exit %i)",
    async (triageExitCode) => {
      const target = await createInstalledTriage(triageExitCode);
      await expect(
        withUpdateFailureTriage({ json: true }, target, async () => {
          try {
            defaultRuntime.writeJson(failedUpdate);
            throw new UpdateCommandFailure(failedUpdate);
          } finally {
            await fs.writeFile(path.join(target.root, "released"), "done");
          }
        }),
      ).rejects.toMatchObject({ code: 1 });

      const receipt = await readReceipt(target);
      expect(receipt).toMatchObject({
        released: true,
        stateDir: target.env.OPENCLAW_STATE_DIR,
        configPath: target.env.OPENCLAW_CONFIG_PATH,
        failure: {
          result: { mode: "npm", reason: "global-install-failed", before: { version: "2026.8.1" } },
        },
      });
      expect(receipt.updateInProgress).toBeUndefined();
      expect(receipt.serviceMarker).toBeUndefined();
      expect(receipt.args).toContain("--json");
      expect(JSON.stringify(receipt.failure)).toContain("ENOSPC");
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(failedUpdate);
      expect(defaultRuntime.log).not.toHaveBeenCalled();
      expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining('"promptPath":'));
      expect(runInteractiveUpdateFailureAction).not.toHaveBeenCalled();
    },
  );

  it("keeps --yes non-interactive and preserves an unexpected updater exception", async () => {
    const target: UpdateTriageTarget & { root: string } = await createInstalledTriage();
    const failure = new Error("Package verification failed unexpectedly");
    target.failureResult = {
      ...failedUpdate,
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    };

    await expect(
      withUpdateFailureTriage({ yes: true }, target, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const receipt = await readReceipt(target);
    expect(receipt.args).toContain("--non-interactive");
    expect(receipt.failure).toMatchObject({
      error: failure.message,
      result: { recovery: { serviceRestartSafe: false } },
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runInteractiveUpdateFailureAction).not.toHaveBeenCalled();
  });

  it.each(["reported", "unexpected"] as const)(
    "exports the final managed %s failure after cleanup without launching triage",
    async (kind) => {
      const { target, contextPath } = await createManagedTriageTarget();
      const result: UpdateRunResult = {
        ...failedUpdate,
        after: { version: "2026.9.1" },
        recovery: { serviceRestartSafe: true, version: "2026.9.1" },
      };
      const targetWithResult: UpdateTriageTarget = { ...target, failureResult: result };
      await fs.writeFile(contextPath, JSON.stringify({ error: "Stale pre-recovery result" }));
      const secret = "sk-test-managed-triage-secret-1234567890";
      const detail = `Fresh Doctor failed token=${secret}; original Doctor diagnostic`;
      const failure =
        kind === "reported" ? new UpdateCommandFailure(result, 1, detail) : new Error(detail);
      const completion = withUpdateFailureTriage({ json: true }, targetWithResult, async () => {
        try {
          throw failure;
        } finally {
          result.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
          await fs.writeFile(path.join(target.root, "released"), "done");
        }
      });
      if (kind === "reported") {
        await expect(completion).rejects.toMatchObject({ code: 1 });
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      } else {
        await expect(completion).rejects.toBe(failure);
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      }

      const raw = await fs.readFile(contextPath, "utf8");
      expect(JSON.parse(raw)).toMatchObject({
        error: expect.stringContaining("original Doctor diagnostic"),
        result: {
          before: { version: "2026.8.1" },
          after: { version: "2026.9.1" },
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          steps: [{ stderrTail: "ENOSPC" }],
        },
      });
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain("Stale pre-recovery result");
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4 * 1024 + 1);
      if (process.platform !== "win32") {
        expect((await fs.stat(contextPath)).mode & 0o777).toBe(0o600);
      }
      await expect(fs.stat(path.join(target.root, "receipt.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(defaultRuntime.log).not.toHaveBeenCalled();
      expect(runInteractiveUpdateFailureAction).not.toHaveBeenCalled();
    },
  );

  it("leaves the outer managed export untouched in a post-core child", async () => {
    const { target, contextPath } = await createManagedTriageTarget();
    Object.assign(target.env, { [POST_CORE_UPDATE_ENV]: "1" });
    const original = JSON.stringify({ error: "Outer updater owns final recovery" });
    await fs.writeFile(contextPath, original);

    await expect(
      withUpdateFailureTriage({}, target, async () => {
        throw new UpdateCommandFailure(failedUpdate, 1);
      }),
    ).rejects.toMatchObject({ code: 1 });

    await expect(fs.readFile(contextPath, "utf8")).resolves.toBe(original);
    await expect(fs.stat(path.join(target.root, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "preview", opts: { dryRun: true }, env: {} },
    { name: "managed helper child", opts: {}, env: { OPENCLAW_UPDATE_RUN_HANDOFF: "1" } },
    { name: "post-core child", opts: {}, env: { [POST_CORE_UPDATE_ENV]: "1" } },
  ])("leaves triage to the owner for $name", async ({ opts, env }) => {
    const target = await createInstalledTriage();
    Object.assign(target.env, env);
    await expect(
      withUpdateFailureTriage(opts, target, async () => {
        throw new UpdateCommandFailure(failedUpdate, 80);
      }),
    ).rejects.toMatchObject({ code: 80 });
    await expect(fs.stat(path.join(target.root, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(target.env.OPENCLAW_STATE_DIR)).rejects.toMatchObject({ code: "ENOENT" });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("uses a new report identity for each distinct CLI update execution", async () => {
    const target = await createInstalledTriage();
    runInteractiveUpdateFailureAction.mockResolvedValue("handled");

    await withTerminal(async () => {
      for (let index = 0; index < 2; index += 1) {
        await expect(
          withUpdateFailureTriage({}, target, async () => {
            throw new UpdateCommandFailure(failedUpdate);
          }),
        ).rejects.toMatchObject({ code: 1 });
      }
    });

    const attemptIds = runInteractiveUpdateFailureAction.mock.calls.map(
      ([params]) => params.attemptId,
    );
    expect(attemptIds).toHaveLength(2);
    expect(attemptIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(attemptIds[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(attemptIds[0]).not.toBe(attemptIds[1]);
  });

  it("passes the admitted run identity to interactive reporting", async () => {
    const target = await createInstalledTriage();
    const runId = "b89e301f-2df4-4dd8-a7ea-4f4b4e10b6f3";
    const opts = { json: false, run: { runId, env: target.env } };
    runInteractiveUpdateFailureAction.mockResolvedValue("handled");

    await withTerminal(async () => {
      await expect(
        withUpdateFailureTriage(opts, target, async () => {
          throw new UpdateCommandFailure(failedUpdate);
        }),
      ).rejects.toMatchObject({ code: 1 });
    });

    expect(runInteractiveUpdateFailureAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ attemptId: runId }),
    );
  });

  it("keeps reporting in the admitted run's state scope", async () => {
    const target = await createInstalledTriage();
    const env = { ...target.env, OPENCLAW_STATE_DIR: path.join(target.root, "admitted-state") };
    const opts = { run: { runId: "b89e301f-2df4-4dd8-a7ea-4f4b4e10b6f3", env } };
    runInteractiveUpdateFailureAction.mockResolvedValue("handled");

    await withTerminal(async () => {
      await expect(
        withUpdateFailureTriage(opts, target, async () => {
          throw new UpdateCommandFailure(failedUpdate);
        }),
      ).rejects.toMatchObject({ code: 1 });
    });

    expect(runInteractiveUpdateFailureAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ env }),
    );
  });

  it("does not start triage when the selected report action throws", async () => {
    const target = await createInstalledTriage();
    const bin = path.join(target.root, "bin");
    const triageReceipt = path.join(target.root, "triage-receipt");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "claude"),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(triageReceipt)}, "called");\n`,
      { mode: 0o700 },
    );
    runInteractiveUpdateFailureAction.mockRejectedValue(new Error("report storage unavailable"));

    await withEnvAsync({ PATH: bin, HOME: target.root, USERPROFILE: target.root }, () =>
      withTerminal(async () => {
        await expect(
          withUpdateFailureTriage({}, target, async () => {
            throw new UpdateCommandFailure(failedUpdate);
          }),
        ).rejects.toMatchObject({ code: 1 });
      }),
    );

    await expect(fs.stat(triageReceipt)).rejects.toMatchObject({ code: "ENOENT" });
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("report storage unavailable"),
    );
  });

  it.each([
    "already-current",
    "managed-service-handoff-started",
    "restart-health-pending",
    "managed-service-handoff-already-running",
    "managed-service-handoff-cancelled",
  ])("does not diagnose intentional or pending %s", async (reason) => {
    const target = await createInstalledTriage();
    await expect(
      withUpdateFailureTriage({}, target, async () => {
        throw new UpdateCommandFailure({ ...failedUpdate, status: "skipped", reason }, 0);
      }),
    ).rejects.toMatchObject({ code: 0 });
    await expect(fs.stat(path.join(target.root, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("retains the diagnostic export when the installed command is broken", async () => {
    const target = await createInstalledTriage();
    await fs.unlink(path.join(target.root, "dist", "index.js"));
    await expect(
      withUpdateFailureTriage({ json: true }, target, async () => {
        throw new UpdateCommandFailure(failedUpdate);
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Saved update failure:"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw triage"));
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("preserves the original failure when diagnostics cannot be written", async () => {
    const target = await createInstalledTriage();
    await fs.writeFile(target.env.OPENCLAW_STATE_DIR, "not a directory");
    const failure = new Error("Original update failure");
    await expect(
      withUpdateFailureTriage({}, target, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Triage could not complete:"),
    );
    await expect(fs.stat(path.join(target.root, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it
    .skipIf(process.platform === "win32")
    .each([
      { stateFailure: "missing", removeCwd: false, agentExitCode: 0 },
      { stateFailure: "missing", removeCwd: true, agentExitCode: 0 },
      { stateFailure: "missing", removeCwd: false, agentExitCode: 23 },
      ...(process.getuid?.() === 0
        ? []
        : [{ stateFailure: "unsearchable", removeCwd: false, agentExitCode: 0 }]),
    ])(
    "starts native recovery outside an unusable state directory ($stateFailure, removed cwd=$removeCwd, agent exit=$agentExitCode)",
    async ({ stateFailure, removeCwd, agentExitCode }) => {
      vi.mocked(defaultRuntime.exit).mockImplementation((code) => {
        throw new ExitError(code);
      });
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const invocationCwd = state.path("operator-shell");
        const brokenStateDir = state.path("unusable-state");
        const receiptPath = state.path("agent-receipts.jsonl");
        const releasedPath = state.path("released");
        const bin = state.path("bin");
        const secret = "sk-test-triage-recovery-secret-1234567890";
        await fs.mkdir(invocationCwd);
        await fs.mkdir(bin);
        if (stateFailure === "missing") {
          await fs.symlink(state.path("unavailable-state-volume"), brokenStateDir, "dir");
        } else {
          await fs.mkdir(brokenStateDir, { mode: 0o600 });
        }
        try {
          await expect(fs.access(brokenStateDir, fs.constants.X_OK)).rejects.toMatchObject({
            code: stateFailure === "missing" ? "ENOENT" : "EACCES",
          });
          await fs.writeFile(
            path.join(bin, "claude"),
            `#!${process.execPath}\n` +
              `const fs = require("node:fs");\n` +
              `fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({\n` +
              `  cwd: fs.realpathSync(process.cwd()),\n` +
              `  home: process.env.HOME,\n` +
              `  stateDir: process.env.OPENCLAW_STATE_DIR,\n` +
              `  configPath: process.env.OPENCLAW_CONFIG_PATH,\n` +
              `  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,\n` +
              `  path: process.env.PATH,\n` +
              `  nodeOptions: process.env.NODE_OPTIONS,\n` +
              `  updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS,\n` +
              `  released: fs.existsSync(${JSON.stringify(releasedPath)}),\n` +
              `  prompt: process.argv[2],\n` +
              `}) + "\\n");\n` +
              `process.exitCode = ${agentExitCode};\n`,
            { mode: 0o700 },
          );
          await withEnvAsync(
            {
              PATH: bin,
              NODE_OPTIONS: "--no-warnings",
              HOME: state.home,
              USERPROFILE: state.home,
              OPENCLAW_WORKSPACE_DIR: state.workspaceDir,
            },
            () =>
              withTerminal(async () => {
                const target: UpdateTriageTarget = { env: { ...process.env } };
                await expect(
                  withUpdateFailureTriage({ invocationCwd }, target, async () => {
                    try {
                      if (removeCwd) {
                        await fs.rmdir(invocationCwd);
                      }
                      target.root = state.path("unavailable-installed-package");
                      target.env = {
                        ...target.env,
                        HOME: state.path("service-home"),
                        PATH: state.path("service-tools"),
                        NODE_OPTIONS: "--trace-warnings",
                        OPENCLAW_STATE_DIR: brokenStateDir,
                        OPENCLAW_UPDATE_IN_PROGRESS: "1",
                      };
                      process.env.HOME = state.path("later-home");
                      process.env.USERPROFILE = state.path("later-home");
                      process.env.PATH = state.path("later-tools");
                      process.env.NODE_OPTIONS = "--trace-warnings";
                      throw new UpdateCommandFailure(
                        {
                          ...failedUpdate,
                          root: target.root,
                          reason: "injected-doctor-failure",
                          after: { version: "2026.9.1" },
                          recovery: {
                            serviceRestartSafe: false,
                            reason: "state-migration-started",
                          },
                          steps: [
                            {
                              name: "doctor",
                              command: "openclaw doctor --fix",
                              cwd: target.root,
                              durationMs: 1,
                              exitCode: 1,
                              stderrTail: "State migration failed",
                            },
                          ],
                        },
                        7,
                        `Doctor failed; Authorization: Bearer ${secret}`,
                      );
                    } finally {
                      await fs.writeFile(releasedPath, "done");
                    }
                  }),
                ).rejects.toMatchObject({ code: 7 });
              }),
          );
          const receipts = (await fs.readFile(receiptPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            cwd: removeCwd ? state.home : invocationCwd,
            home: state.home,
            stateDir: brokenStateDir,
            configPath: state.configPath,
            workspaceDir: state.workspaceDir,
            path: bin,
            nodeOptions: "--no-warnings",
            released: true,
          });
          expect(receipts[0].updateInProgress).toBeUndefined();
          expect(receipts[0].prompt).toContain("injected-doctor-failure");
          expect(receipts[0].prompt).not.toContain(secret);
          expect(defaultRuntime.error).toHaveBeenCalledWith(
            expect.stringContaining("Debugging prompt could not be saved:"),
          );
          expect(defaultRuntime.log).not.toHaveBeenCalledWith(
            expect.stringMatching(/^Debugging prompt: /u),
          );
          if (agentExitCode !== 0) {
            expect(defaultRuntime.error).toHaveBeenCalledWith(
              expect.stringContaining(`Triage exited with code ${agentExitCode}`),
            );
          }
          expect(defaultRuntime.exit).not.toHaveBeenCalled();
        } finally {
          if (stateFailure === "unsearchable") {
            await fs.chmod(brokenStateDir, 0o700);
          }
        }
      });
    },
  );
});

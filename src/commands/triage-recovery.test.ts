import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareUpdateCommandCompletion } from "../cli/update-cli/update-command-completion.js";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../infra/restart-sentinel.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { triageCommand } from "./triage.js";

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  resolveExecutablePath: vi.fn(),
  select: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./doctor-lint.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: mocks.resolveExecutablePath,
}));
vi.mock("./configure.shared.js", () => ({ select: mocks.select }));

const agents = ["claude", "codex", "opencode", "pi"] as const;
const secret = "sk-test-triage-recovery-secret-1234567890";

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

async function withTerminal(interactive: boolean, run: () => Promise<void>) {
  const streams = [process.stdin, process.stdout];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: interactive });
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

function failedUpdate(root: string): UpdateRunResult {
  return {
    status: "error",
    mode: "npm",
    root,
    reason: "injected-doctor-failure",
    before: { version: "2026.8.25" },
    after: { version: "2026.8.26" },
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    steps: [
      {
        name: "doctor",
        command: "openclaw doctor --fix",
        cwd: root,
        exitCode: 1,
        durationMs: 12,
        stderrTail: `Migration failed at ${root}/runtime-entry.js; Authorization: Bearer ${secret}; ${"🦞".repeat(600)}`,
        stdoutTail: "lower-priority-step-output",
      },
    ],
    durationMs: 15,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectDoctorFindings.mockResolvedValue([]);
  mocks.resolveExecutablePath.mockImplementation((agent: string) => `/usr/local/bin/${agent}`);
  mocks.select.mockResolvedValue({ kind: "print" });
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  });
});

afterEach(() => vi.restoreAllMocks());

describe("triage external recovery handoff", () => {
  it.each(agents)(
    "starts the first available agent immediately when that agent is %s",
    async (agent) => {
      const available = new Set(agents.slice(agents.indexOf(agent)));
      mocks.resolveExecutablePath.mockImplementation((binary: typeof agent) =>
        available.has(binary) ? `/usr/local/bin/${binary}` : undefined,
      );
      await withOpenClawTestState({ layout: "split" }, async () => {
        await withTerminal(true, () => triageCommand(createRuntime(), { noExport: true }));
      });
      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        `/usr/local/bin/${agent}`,
        agent === "opencode" ? ["--prompt", expect.any(String)] : [expect.any(String)],
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it.each(agents)(
    "honors explicit --agent %s without selecting another installed agent",
    async (agent) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        await withTerminal(true, () => triageCommand(createRuntime(), { noExport: true, agent }));
      });
      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        `/usr/local/bin/${agent}`,
        agent === "opencode" ? ["--prompt", expect.any(String)] : [expect.any(String)],
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "never launches from JSON or noninteractive output (json=%s)",
    async (json) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        const runtime = createRuntime();
        await withTerminal(json, () =>
          triageCommand(runtime, { json, noExport: true, agent: "opencode" }),
        );
        if (json) {
          expect(runtime.writeJson).toHaveBeenCalledWith(
            expect.objectContaining({
              detectedAgents: agents,
              suggestedCommands: expect.arrayContaining([
                expect.stringContaining("opencode --prompt"),
                expect.stringContaining(" pi "),
              ]),
            }),
            2,
          );
        }
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.select).not.toHaveBeenCalled();
      });
    },
  );

  it("reports a missing explicit agent without falling back to an available agent", async () => {
    mocks.resolveExecutablePath.mockImplementation((agent: string) =>
      agent === "claude" ? "/usr/local/bin/claude" : undefined,
    );
    await withOpenClawTestState({ layout: "split" }, async () => {
      const runtime = createRuntime();
      await expect(
        withTerminal(true, () => triageCommand(runtime, { noExport: true, agent: "pi" })),
      ).rejects.toMatchObject({ code: 1 });
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringMatching(/pi.*(?:not found|not installed|unavailable)/iu),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it("does not try another provider after the selected agent fails to start", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("permission denied")));
      return child;
    });
    await withOpenClawTestState({ layout: "split" }, async () => {
      const runtime = createRuntime();
      await expect(
        withTerminal(true, () => triageCommand(runtime, { noExport: true })),
      ).rejects.toMatchObject({ code: 1 });
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).toHaveBeenCalledWith(expect.stringMatching(/^Run manually: .*claude /u));
    });
  });

  it("launches recovery from the captured target without fresh Doctor or export enrichment", async () => {
    mocks.collectDoctorFindings.mockRejectedValue(
      new Error(`Doctor import unavailable; token=${secret}`),
    );
    mocks.writeDiagnosticSupportExport.mockRejectedValue(
      new Error("Diagnostics chunk unavailable"),
    );
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const target = resolveInstallationTarget();
      const update = failedUpdate(state.statePath("install"));
      const doctorStep = update.steps[0]!;
      update.steps = [
        ...["older-failure", "recent-failure", "latest-failure"].map((name) =>
          Object.assign({}, doctorStep, { name }),
        ),
        doctorStep,
        { ...doctorStep, name: "successful-step", exitCode: 0 },
        { ...doctorStep, name: "unknown-step", exitCode: null },
      ];
      const runtime = createRuntime();
      await withTerminal(true, () =>
        triageCommand(runtime, { recovery: { target, cwd: state.workspaceDir, update } }),
      );
      expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
        "/usr/local/bin/claude",
        [expect.any(String)],
        expect.objectContaining({
          cwd: state.workspaceDir,
          stdio: "inherit",
          env: expect.objectContaining({
            OPENCLAW_STATE_DIR: target.stateDir,
            OPENCLAW_CONFIG_PATH: target.configPath,
            OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
          }),
        }),
      );
      const prompt = String(mocks.spawn.mock.calls[0]?.[1]?.[0]);
      expect(prompt).toContain("injected-doctor-failure");
      expect(prompt).toContain("2026.8.25");
      expect(prompt).toContain("2026.8.26");
      expect(prompt).toContain('"serviceRestartSafe": false');
      expect(mocks.collectDoctorFindings).not.toHaveBeenCalled();
      expect(mocks.writeDiagnosticSupportExport).not.toHaveBeenCalled();
      expect(prompt).toMatch(/Doctor checks deferred/iu);
      expect(prompt).toMatch(/Diagnostics export deferred/iu);
      expect(prompt).not.toContain("with `--no-export`");
      expect(prompt).toContain("Migration failed at $OPENCLAW_STATE_DIR/install/runtime-entry.js");
      expect(prompt).not.toContain("lower-priority-step-output");
      const evidence = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(prompt)?.[1] ?? "") as {
        steps: { name: string; diagnosticExcerpt: string }[];
      };
      expect(evidence.steps.map((step) => step.name)).toEqual([
        "recent-failure",
        "latest-failure",
        "doctor",
      ]);
      for (const step of evidence.steps) {
        expect(Buffer.byteLength(step.diagnosticExcerpt, "utf8")).toBeLessThanOrEqual(384);
      }
      expect(prompt).toMatch(/autonomously/iu);
      expect(prompt).toMatch(/preserve.*(?:state|history|database)/iu);
      expect(prompt).not.toContain(secret);
      expect(prompt).not.toContain(state.stateDir);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it
    .skipIf(process.platform === "win32")
    .each([
      { stateFailure: "missing", removeCwd: false },
      { stateFailure: "missing", removeCwd: true },
      ...(process.getuid?.() === 0 ? [] : [{ stateFailure: "unsearchable", removeCwd: false }]),
    ])(
    "starts native recovery outside an unusable state directory ($stateFailure, removed cwd=$removeCwd)",
    async ({ stateFailure, removeCwd }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const invocationCwd = state.path("operator-shell");
        const brokenStateDir = state.path("unusable-state");
        const receiptPath = state.path("agent-receipt.json");
        const agentPath = state.path("claude");
        await fs.mkdir(invocationCwd);
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
            agentPath,
            `#!${process.execPath}\n` +
              `const fs = require("node:fs");\n` +
              `fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({\n` +
              `  cwd: fs.realpathSync(process.cwd()),\n` +
              `  stateDir: process.env.OPENCLAW_STATE_DIR,\n` +
              `  configPath: process.env.OPENCLAW_CONFIG_PATH,\n` +
              `  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,\n` +
              `  prompt: process.argv[2],\n` +
              `}));\n`,
            { mode: 0o700 },
          );
          const children =
            await vi.importActual<typeof import("node:child_process")>("node:child_process");
          mocks.spawn.mockImplementation(children.spawn);
          mocks.resolveExecutablePath.mockImplementation((agent: string) =>
            agent === "claude" ? agentPath : undefined,
          );
          const runtime = createRuntime();
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: brokenStateDir,
              OPENCLAW_WORKSPACE_DIR: state.workspaceDir,
            },
            async () => {
              await expect(
                withTerminal(true, async () => {
                  const complete = await prepareUpdateCommandCompletion({ runtime, invocationCwd });
                  if (removeCwd) {
                    await fs.rmdir(invocationCwd);
                  }
                  await complete({
                    result: failedUpdate(path.join(brokenStateDir, "install")),
                    exitCode: 7,
                  });
                }),
              ).rejects.toMatchObject({ code: 7 });
            },
          );

          const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
          expect(receipt).toMatchObject({
            cwd: removeCwd ? state.home : invocationCwd,
            stateDir: brokenStateDir,
            configPath: state.configPath,
            workspaceDir: state.workspaceDir,
          });
          expect(receipt.prompt).toContain("injected-doctor-failure");
          expect(receipt.prompt).not.toContain(secret);
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Debugging prompt could not be saved:"),
          );
          expect(runtime.log).not.toHaveBeenCalledWith(
            expect.stringMatching(/^Debugging prompt: /u),
          );
          expect(mocks.spawn).toHaveBeenCalledOnce();
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(7);
        } finally {
          if (stateFailure === "unsearchable") {
            await fs.chmod(brokenStateDir, 0o700);
          }
        }
      });
    },
  );

  it.each(["mkdir", "writeFile"] as const)(
    "launches native recovery when the prompt artifact %s is denied",
    async (operation) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const target = resolveInstallationTarget();
        await fs.access(target.stateDir);
        await fs.access(state.home);
        const artifactError = Object.assign(
          new Error(`EACCES: support artifact permission denied; token=${secret}`),
          { code: "EACCES" },
        );
        vi.spyOn(fs, operation).mockRejectedValueOnce(artifactError);
        const runtime = createRuntime();

        await withTerminal(true, () =>
          triageCommand(runtime, {
            noExport: true,
            recovery: {
              target,
              cwd: state.workspaceDir,
              update: failedUpdate(state.statePath("install")),
            },
          }),
        );

        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
          "/usr/local/bin/claude",
          [expect.stringContaining("injected-doctor-failure")],
          expect.objectContaining({ cwd: state.workspaceDir, stdio: "inherit" }),
        );
        const output = JSON.stringify([runtime.log.mock.calls, runtime.error.mock.calls]);
        expect(output).toContain("EACCES");
        expect(output).not.toContain(secret);
        expect(runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/^Debugging prompt: /u));
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { json: true, terminal: true },
    { json: false, terminal: false },
  ])(
    "keeps prompt artifact failure explicit without interactive handoff (json=$json)",
    async ({ json, terminal }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const target = resolveInstallationTarget();
        vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
          Object.assign(new Error("EACCES: support artifact permission denied"), {
            code: "EACCES",
          }),
        );
        const runtime = createRuntime();

        await expect(
          withTerminal(terminal, () =>
            triageCommand(runtime, {
              json,
              noExport: true,
              recovery: { target, update: failedUpdate(state.statePath("install")) },
            }),
          ),
        ).rejects.toMatchObject({ code: "EACCES" });

        expect(runtime.writeJson).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );
});

describe("standalone triage update evidence", () => {
  it("reads an offline failed-update sentinel without consuming it or exposing routing instructions", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const saved = await writeRestartSentinel({
        kind: "update",
        status: "error",
        ts: 1,
        sessionKey: "private-session-route",
        message: "private-operator-note",
        continuation: { kind: "agentTurn", message: "untrusted-continuation-instruction" },
        stats: {
          mode: "npm",
          root: state.statePath("install"),
          reason: "background-doctor-failure",
          before: { version: "2026.8.25", unrelated: "private-before-metadata" },
          after: { version: "2026.8.26", instructions: "untrusted-version-instruction" },
          steps: [
            {
              name: "doctor",
              command: "openclaw doctor --fix",
              log: {
                exitCode: 1,
                stderrTail: " \n",
                stdoutTail: `EACCES: cannot open ${state.statePath("install", "runtime-entry.js")} token=${secret}`,
              },
            },
          ],
        },
      });
      const runtime = createRuntime();
      await triageCommand(runtime, { json: true, noExport: true });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).toContain("background-doctor-failure");
      expect(prompt).toContain("2026.8.26");
      expect(prompt).toContain('"serviceRestartSafe": null');
      expect(prompt).toContain("EACCES: cannot open $OPENCLAW_STATE_DIR/install/runtime-entry.js");
      for (const omitted of [
        secret,
        "private-session-route",
        "private-operator-note",
        "untrusted-continuation-instruction",
        "private-before-metadata",
        "untrusted-version-instruction",
      ]) {
        expect(prompt).not.toContain(omitted);
      }
      expect(await readRestartSentinelReadOnly()).toEqual(saved);
    });
  });

  it("prefers the current updater failure over an older pending notification", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      await writeRestartSentinel({
        kind: "update",
        status: "error",
        ts: 1,
        stats: { reason: "older-pending-failure" },
      });
      const runtime = createRuntime();
      await triageCommand(runtime, {
        json: true,
        noExport: true,
        recovery: {
          target: resolveInstallationTarget(),
          update: failedUpdate(state.statePath("install")),
        },
      });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).toContain("injected-doctor-failure");
      expect(prompt).not.toContain("older-pending-failure");
    });
  });

  it.each(["ok", "skipped"] as const)(
    "does not interpret a %s update notification as recovery authority",
    async (status) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        await writeRestartSentinel({
          kind: "update",
          status,
          ts: 1,
          stats: { reason: "not-a-failed-update" },
        });
        const runtime = createRuntime();
        await triageCommand(runtime, { json: true, noExport: true });
        const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
        expect(prompt).not.toContain("not-a-failed-update");
      });
    },
  );

  it("keeps an absent update outcome unknown without creating a state database", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const databasePath = path.join(state.stateDir, "state", "openclaw.sqlite");
      await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await triageCommand(createRuntime(), { json: true, noExport: true });
      await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

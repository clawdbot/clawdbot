import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstallationTarget } from "../infra/installation-target-context.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../infra/restart-sentinel.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
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
const printOnlyModes = [
  { mode: "JSON", json: true, nonInteractive: false, terminal: true },
  { mode: "--non-interactive", json: false, nonInteractive: true, terminal: true },
  { mode: "non-TTY", json: false, nonInteractive: false, terminal: false },
] as const;
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
        stderrTail: `${"🦞".repeat(600)} Migration failed at ${root}/runtime-entry.js; Authorization: Bearer ${secret}`,
        stdoutTail: "compiler-output-cause",
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

  it.each(printOnlyModes)(
    "never launches an explicitly selected agent in $mode mode",
    async ({ json, nonInteractive, terminal }) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        const runtime = createRuntime();
        await withTerminal(terminal, () =>
          triageCommand(runtime, { json, nonInteractive, noExport: true, agent: "opencode" }),
        );
        if (json) {
          expect(runtime.writeJson).toHaveBeenCalledWith(
            expect.objectContaining({
              detectedAgents: agents,
              suggestedCommands: expect.arrayContaining([
                expect.stringContaining("opencode run"),
                expect.stringContaining("pi --print"),
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
        {
          ...doctorStep,
          name: "interrupted-step",
          exitCode: null,
          termination: "signal",
          stderrTail: "Update child terminated before reporting an exit code",
        },
        {
          ...doctorStep,
          name: "advisory-step",
          advisory: { kind: "package-post-install-doctor", message: "Recoverable Doctor advice" },
        },
      ];
      const runtime = createRuntime();
      await withTerminal(true, () =>
        triageCommand(runtime, {
          recovery: { target, cwd: state.workspaceDir, updateFailure: { result: update } },
        }),
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
      expect(mocks.collectDoctorFindings).not.toHaveBeenCalled();
      expect(mocks.writeDiagnosticSupportExport).not.toHaveBeenCalled();
      expect(prompt).toMatch(/Doctor checks deferred/iu);
      expect(prompt).toMatch(/Diagnostics export deferred/iu);
      expect(prompt).not.toContain("with `--no-export`");
      const details = /```json\n([\s\S]+?)\n```/u.exec(prompt)?.[1] ?? "";
      expect(JSON.parse(details)).toMatchObject({
        result: {
          recovery: { serviceRestartSafe: false },
          steps: [
            { name: "latest-failure", exitCode: 1 },
            {
              name: "doctor",
              exitCode: 1,
              stderrTail: expect.stringContaining(
                "Migration failed at $OPENCLAW_STATE_DIR/install/runtime-entry.js",
              ),
              stdoutTail: "compiler-output-cause",
            },
            {
              name: "interrupted-step",
              exitCode: null,
              termination: "signal",
              stderrTail: "Update child terminated before reporting an exit code",
            },
          ],
        },
      });
      expect(Buffer.byteLength(details)).toBeLessThanOrEqual(4 * 1024);
      expect(prompt).toMatch(/autonomously/iu);
      expect(prompt).toMatch(/preserve.*(?:state|history|database)/iu);
      expect(prompt).not.toContain(secret);
      expect(prompt).not.toContain(state.stateDir);
      expect(prompt).not.toContain("\uFFFD");
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

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
        vi.spyOn(fs, operation).mockRejectedValue(artifactError);
        const runtime = createRuntime();

        await withTerminal(true, () =>
          triageCommand(runtime, {
            noExport: true,
            recovery: {
              target,
              cwd: state.workspaceDir,
              updateFailure: { result: failedUpdate(state.statePath("install")) },
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

  it.each(printOnlyModes)(
    "keeps prompt artifact failure explicit without interactive handoff in $mode mode",
    async ({ json, nonInteractive, terminal }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const target = resolveInstallationTarget();
        vi.spyOn(fs, "writeFile").mockRejectedValue(
          Object.assign(new Error("EACCES: support artifact permission denied"), {
            code: "EACCES",
          }),
        );
        const runtime = createRuntime();

        await expect(
          withTerminal(terminal, () =>
            triageCommand(runtime, {
              json,
              nonInteractive,
              noExport: true,
              recovery: {
                target,
                updateFailure: { result: failedUpdate(state.statePath("install")) },
              },
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
  it.each([
    { status: "error" as const, reason: "background-doctor-failure" },
    { status: "skipped" as const, reason: "dirty" },
  ])(
    "reads a failed $status sentinel without consuming it or exposing routing instructions",
    async ({ status, reason }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const saved = await writeRestartSentinel({
          kind: "update",
          status,
          ts: 1,
          sessionKey: "private-session-route",
          message: "private-operator-note",
          continuation: { kind: "agentTurn", message: "untrusted-continuation-instruction" },
          stats: {
            mode: "npm",
            root: state.statePath("install"),
            reason,
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
        expect(prompt).toContain(reason);
        expect(prompt).toContain("2026.8.26");
        const evidence = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(prompt)?.[1] ?? "");
        expect(evidence.result.recovery).toBeUndefined();
        expect(prompt).toContain(
          "EACCES: cannot open $OPENCLAW_STATE_DIR/install/runtime-entry.js",
        );
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
    },
  );

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
          updateFailure: { result: failedUpdate(state.statePath("install")) },
        },
      });
      const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
      expect(prompt).toContain("injected-doctor-failure");
      expect(prompt).not.toContain("older-pending-failure");
    });
  });

  it.each([
    { status: "ok" as const, reason: "completed-update" },
    { status: "skipped" as const, reason: "already-current" },
    { status: "skipped" as const, reason: "managed-service-handoff-started" },
  ])(
    "does not project a $status/$reason notification as a failed update",
    async ({ status, reason }) => {
      await withOpenClawTestState({ layout: "split" }, async () => {
        await writeRestartSentinel({
          kind: "update",
          status,
          ts: 1,
          stats: { reason },
        });
        const runtime = createRuntime();
        await triageCommand(runtime, { json: true, noExport: true });
        const prompt = await fs.readFile(runtime.writeJson.mock.calls[0]?.[0]?.promptPath, "utf8");
        expect(prompt).not.toContain(reason);
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

/** CLI trajectory proof uses real child processes and the canonical SQLite store. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as trajectoryMetadata from "../../trajectory/metadata.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { runCliAgent as runCliAgentImpl } from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { FailoverError } from "../failover-error.js";
import type { RunCliAgentParams } from "./types.js";

const { prepareContext } = vi.hoisted(() => ({ prepareContext: vi.fn() }));
// Replace credential/plugin discovery only; runner, recovery, executor, and SQLite stay real.
vi.mock("./prepare.runtime.js", () => ({ prepareCliRunContext: prepareContext }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function runCliAgent(params: RunCliAgentParams) {
  const admission = prepareSystemAgentRunAdmission({}, params.runId, "main", "trajectory-fixture");
  try {
    return await runCliAgentImpl({
      ...params,
      admittedRunContext: await admission.admit("embedded"),
    });
  } finally {
    admission.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  prepareContext.mockReset();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function fixture(
  options: {
    fail?: boolean;
    disabled?: boolean;
    recover?: boolean;
    abortKind?: "manual" | "timeout";
  } = {},
) {
  vi.stubEnv("OPENCLAW_TRAJECTORY", options.disabled ? "0" : "1");
  const root = tempDirs.make("openclaw-cli-trajectory-");
  const target = {
    agentId: "main",
    sessionId: "openclaw-session",
    sessionKey: "agent:main:trajectory",
    storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const abortController = options.abortKind ? new AbortController() : undefined;
  const script = options.abortKind
    ? "setTimeout(() => {}, 30_000)"
    : options.fail
      ? 'process.stderr.write("fixture process failed"); process.exitCode = 1'
      : options.recover
        ? 'if (process.env.FIXTURE_SESSION === "stale-session") { process.stderr.write("fixture session expired"); process.exitCode = 1; } else { process.stdout.write("fixture reply"); }'
        : 'process.stdout.write("fixture reply")';
  const context = buildPreparedCliRunContext({
    sessionTarget: target,
    workspaceDir: root,
    runId: "trajectory-run",
    prompt: "Explain the fixture",
    timeoutMs: 10_000,
    backend: {
      command: process.execPath,
      args: ["-e", script],
      ...(options.recover ? { resumeArgs: ["-e", script] } : {}),
      modelArg: undefined,
      sessionArgs: undefined,
      systemPromptFileArg: undefined,
      sessionMode: "existing",
      input: "stdin",
    },
  });
  context.backendResolved.bundleMcp = false;
  if (abortController) {
    context.params.abortSignal = abortController.signal;
  }
  if (options.recover) {
    context.reusableCliSession = { mode: "reuse", sessionId: "stale-session" };
    context.openClawHistoryPrompt = "Earlier history\nExplain the fixture";
  }
  context.executionTarget = {
    kind: "plugin",
    async *execute(execution) {
      const child = spawn(execution.command, execution.args, {
        cwd: execution.cwd,
        // The fixture needs no credentials or external services.
        env: { FIXTURE_SESSION: execution.sessionId ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const abortSignal = execution.abortSignal;
      const abortChild = () => child.kill();
      abortSignal?.addEventListener("abort", abortChild, { once: true });
      if (abortController) {
        queueMicrotask(() => {
          if (options.abortKind === "timeout") {
            const timeout = new Error("fixture deadline exceeded");
            timeout.name = "TimeoutError";
            abortController.abort(timeout);
          } else {
            abortController.abort();
          }
        });
      }
      const [[code], stdout, stderr] = await Promise.all([
        once(child, "close"),
        text(child.stdout),
        text(child.stderr),
      ]).finally(() => abortSignal?.removeEventListener("abort", abortChild));
      if (code !== 0) {
        if (options.recover) {
          throw new FailoverError(stderr, { reason: "session_expired", provider: "claude-cli" });
        }
        throw new Error(stderr || `Fixture exited with code ${code}`);
      }
      yield { type: "result", subtype: "success", result: stdout };
    },
  };
  prepareContext.mockImplementation(async (params: RunCliAgentParams) => ({ ...context, params }));
  return {
    context,
    events: () => loadSqliteTrajectoryRuntimeEvents(target),
  };
}

it("persists a complete CLI turn in SQLite before resolving", async () => {
  const { context, events } = await fixture();
  await expect(runCliAgent(context.params)).resolves.toMatchObject({
    payloads: [{ text: "fixture reply" }],
  });
  const recorded = await events();
  expect(recorded.map((event) => event.type)).toEqual([
    "session.started",
    "trace.metadata",
    "prompt.submitted",
    "model.completed",
    "session.ended",
  ]);
  expect(recorded.find((event) => event.type === "prompt.submitted")?.data).toMatchObject({
    prompt: "Explain the fixture",
  });
  expect(recorded.find((event) => event.type === "model.completed")?.data).toMatchObject({
    assistantTexts: ["fixture reply"],
    stopReason: "completed",
  });
  expect(recorded.at(-1)?.data).toMatchObject({ status: "success" });
  expect(recorded.every((event) => event.sessionId === "openclaw-session")).toBe(true);
});

it("captures transformed prompt context at the CLI dispatch boundary", async () => {
  const { context, events } = await fixture();
  context.backendResolved.textTransforms = { input: [{ from: "fixture", to: "example" }] };
  context.promptContext = { prependContext: "fixture guidance", appendContext: "fixture reminder" };
  await runCliAgent(context.params);
  expect((await events()).find((event) => event.type === "prompt.submitted")?.data).toMatchObject({
    prompt: "example guidance\n\nExplain the example\n\nexample reminder",
  });
});

it("still executes and cleans up when trajectory metadata capture fails", async () => {
  const { context, events } = await fixture();
  vi.spyOn(trajectoryMetadata, "buildTrajectoryRunMetadata").mockImplementationOnce(() => {
    throw new Error("fixture metadata failure");
  });
  let cleanedUp = false;
  context.preparedBackend.cleanup = async () => {
    cleanedUp = true;
  };
  await expect(runCliAgent(context.params)).resolves.toMatchObject({
    payloads: [{ text: "fixture reply" }],
  });
  expect(cleanedUp).toBe(true);
  expect(await events()).toEqual([]);
});

it("does not persist isolated completion into a borrowed session target", async () => {
  const { context, events } = await fixture();
  context.params.isolatedCompletion = true;
  await expect(runCliAgent(context.params)).resolves.toMatchObject({
    payloads: [{ text: "fixture reply" }],
  });
  expect(await events()).toEqual([]);
});

it("flushes a terminal CLI process failure without reporting completion", async () => {
  const { context, events } = await fixture({ fail: true });
  await expect(runCliAgent(context.params)).rejects.toThrow("fixture process failed");
  const recorded = await events();
  expect(recorded.map((event) => event.type)).toEqual([
    "session.started",
    "trace.metadata",
    "prompt.submitted",
    "session.ended",
  ]);
  expect(recorded.at(-1)?.data).toMatchObject({
    status: "error",
    promptError: "fixture process failed",
  });
});

it.each([
  { abortKind: "manual" as const, timedOut: false },
  { abortKind: "timeout" as const, timedOut: true },
])("distinguishes $abortKind cancellation in the final trajectory event", async (testCase) => {
  const { context, events } = await fixture({ abortKind: testCase.abortKind });
  await expect(runCliAgent(context.params)).rejects.toMatchObject({ name: "AbortError" });
  expect((await events()).at(-1)).toMatchObject({
    type: "session.ended",
    data: {
      status: "interrupted",
      aborted: true,
      timedOut: testCase.timedOut,
    },
  });
});

it("leaves trajectory disabled while still executing the CLI", async () => {
  const { context, events } = await fixture({ disabled: true });
  await expect(runCliAgent(context.params)).resolves.toMatchObject({
    payloads: [{ text: "fixture reply" }],
  });
  expect(await events()).toEqual([]);
});

it("records both retry prompts but ends a recovered CLI turn only once", async () => {
  const { context, events } = await fixture({ recover: true });
  await expect(runCliAgent(context.params)).resolves.toMatchObject({
    payloads: [{ text: "fixture reply" }],
  });
  const recorded = await events();
  expect(recorded.map((event) => event.type)).toEqual([
    "session.started",
    "trace.metadata",
    "prompt.submitted",
    "prompt.submitted",
    "model.completed",
    "session.ended",
  ]);
  expect(
    recorded
      .filter((event) => event.type === "prompt.submitted")
      .map((event) => event.data?.prompt),
  ).toEqual(["Explain the fixture", "Earlier history\nExplain the fixture"]);
  expect(recorded.at(-1)?.data).toMatchObject({ status: "success" });
});

it("records cleanup failure as the final outcome after successful CLI output", async () => {
  const { context, events } = await fixture();
  context.preparedBackend.cleanup = async () => {
    throw new Error("fixture cleanup failed");
  };
  await expect(runCliAgent(context.params)).rejects.toThrow("fixture cleanup failed");
  const recorded = await events();
  expect(recorded.find((event) => event.type === "model.completed")?.data).toMatchObject({
    assistantTexts: ["fixture reply"],
  });
  expect(recorded.filter((event) => event.type === "session.ended")).toHaveLength(1);
  expect(recorded.at(-1)?.data).toMatchObject({
    status: "error",
    promptError: "fixture cleanup failed",
  });
});

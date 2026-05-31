import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTrajectoryPointerFilePath } from "../trajectory/paths.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand, setSessionsTailFollowIntervalMsForTests } from "./sessions-tail.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

const sessionKey = "agent:main:telegram:direct:owner";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function makeEvent(
  params: Partial<TrajectoryEvent> & { type: string; ts: string },
): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace-1",
    source: "runtime",
    seq: 1,
    sessionId: "session-one",
    sessionKey,
    ...params,
  };
}

function writeJsonl(filePath: string, events: TrajectoryEvent[]): void {
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function appendJsonl(filePath: string, event: TrajectoryEvent): void {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

function runtimeOutput(runtime: RuntimeEnv): string {
  return vi
    .mocked(runtime.log)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

async function waitForRuntimeOutput(
  runtime: RuntimeEnv,
  pattern: string,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!runtimeOutput(runtime).includes(pattern)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for output containing ${pattern}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("sessionsTailCommand", () => {
  let tmpDir: string;
  let storePath: string;
  let trajectoryPath: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    setSessionsTailFollowIntervalMsForTests(10);
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-tail-"));
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        list: [{ id: "main" }, { id: "ops" }],
      },
    });
    storePath = path.join(tmpDir, "sessions.json");
    trajectoryPath = path.join(tmpDir, "session-one.trajectory.jsonl");
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({
        [sessionKey]: {
          sessionId: "session-one",
          sessionFile: "session-one.jsonl",
          updatedAt: 2,
          status: "running",
        },
      })}\n`,
    );
  });

  afterEach(() => {
    setSessionsTailFollowIntervalMsForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders compact redacted progress lines", async () => {
    const runtime = makeRuntime();
    writeJsonl(trajectoryPath, [
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash", arguments: { command: "echo SECRET" } },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true, output: "SECRET" },
      }),
      makeEvent({
        type: "model.completed",
        ts: "2026-05-18T12:04:29.000Z",
        provider: "openai",
        modelId: "gpt-5.2",
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("12:04:18");
    expect(output).toContain("tool.call");
    expect(output).toContain("bash {...redacted...}");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).toContain("model.completed");
    expect(output).toContain("openai/gpt-5.2 done");
    expect(output).not.toContain("SECRET");
  });

  it("honors the tail count before rendering existing trajectory events", async () => {
    const runtime = makeRuntime();
    writeJsonl(trajectoryPath, [
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
      makeEvent({
        type: "tool.call",
        ts: "2026-05-18T12:04:18.000Z",
        data: { name: "bash" },
      }),
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey, tail: "2" }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).not.toContain("session.started");
    expect(output).toContain("tool.call");
    expect(output).toContain("tool.result");
  });

  it("uses a session trajectory pointer for relocated runtime files", async () => {
    const runtime = makeRuntime();
    const relocatedDir = path.join(tmpDir, "relocated-trajectories");
    const relocatedTrajectoryPath = path.join(relocatedDir, "session-one.jsonl");
    fs.mkdirSync(relocatedDir, { recursive: true });
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(path.join(tmpDir, "session-one.jsonl")),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-one",
        runtimeFile: relocatedTrajectoryPath,
      })}\n`,
    );
    writeJsonl(relocatedTrajectoryPath, [
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).not.toContain("No sessions found");
  });

  it("preserves events appended while follow mode starts", async () => {
    const runtime = makeRuntime();
    writeJsonl(trajectoryPath, [
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
    ]);
    const appendedEvent = makeEvent({
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "bash", success: true },
    });
    let appended = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!appended && String(message).includes("session.started")) {
        appended = true;
        appendJsonl(trajectoryPath, appendedEvent);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "bash ok");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("session.started");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
  });

  it("continues following when a bounded trajectory window is rewritten", async () => {
    const runtime = makeRuntime();
    writeJsonl(trajectoryPath, [
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const rewrittenEvent = makeEvent({
      sourceSeq: 2,
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "python", success: true },
    });
    let rewritten = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!rewritten && String(message).includes("session.started")) {
        rewritten = true;
        const nextPath = path.join(tmpDir, "session-one.next.trajectory.jsonl");
        writeJsonl(nextPath, [rewrittenEvent]);
        fs.renameSync(nextPath, trajectoryPath);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "python ok");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("python ok");
  });

  it("resolves the target store from a fully qualified non-default agent session key", async () => {
    const runtime = makeRuntime();
    const opsSessionKey = "agent:ops:telegram:direct:owner";
    const opsSessionsDir = path.join(process.env.OPENCLAW_STATE_DIR!, "agents", "ops", "sessions");
    fs.mkdirSync(opsSessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(opsSessionsDir, "sessions.json"),
      `${JSON.stringify({
        [opsSessionKey]: {
          sessionId: "ops-session",
          sessionFile: "ops-session.jsonl",
          updatedAt: 3,
          status: "done",
        },
      })}\n`,
    );
    writeJsonl(path.join(opsSessionsDir, "ops-session.trajectory.jsonl"), [
      makeEvent({
        sessionId: "ops-session",
        sessionKey: opsSessionKey,
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "bash", success: true },
      }),
    ]);

    await sessionsTailCommand({ sessionKey: opsSessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("agent:ops:telegram:direct:own…");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).not.toContain("No sessions found");
  });
});

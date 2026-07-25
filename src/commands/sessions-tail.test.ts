// Sessions tail tests cover transcript tailing, filtering, and session-store setup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  resolveTrajectoryPointerFilePath,
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
} from "../trajectory/paths.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand } from "./sessions-tail.js";
import { setSessionsTailFollowIntervalMsForTests } from "./sessions-tail.test-support.js";

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe("sessionsTailCommand", () => {
  let tmpDir: string;
  let storePath: string;
  let trajectoryPath: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    setSessionsTailFollowIntervalMsForTests(2);
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
  });

  afterEach(() => {
    setSessionsTailFollowIntervalMsForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeSessionEntry(
    key = sessionKey,
    entry: Partial<SessionEntry> = {},
  ): Promise<void> {
    await replaceSessionEntry(
      { sessionKey: key, storePath },
      {
        sessionId: "session-one",
        sessionFile: "session-one.jsonl",
        updatedAt: 2,
        status: "running",
        ...entry,
      },
    );
  }

  async function appendEvents(
    events: TrajectoryEvent[],
    params: { key?: string; sessionId?: string } = {},
  ): Promise<void> {
    const targetPath =
      params.sessionId && params.sessionId !== "session-one"
        ? path.join(tmpDir, `${params.sessionId}.trajectory.jsonl`)
        : trajectoryPath;
    writeJsonl(
      targetPath,
      events.map((event) => ({ ...event, sessionKey: params.key ?? event.sessionKey })),
    );
  }

  it("renders compact redacted progress lines", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
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
    await writeSessionEntry();
    await appendEvents([
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

  it("rejects tail counts that exceed JavaScript safe integer precision", async () => {
    const runtime = makeRuntime();

    await sessionsTailCommand({ store: storePath, sessionKey, tail: "9007199254740992" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--tail must be a non-negative integer, for example --tail 25.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("uses a session trajectory pointer for relocated runtime files", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    const sessionFile = path.join(tmpDir, "session-one.jsonl");
    const relocatedDir = path.join(tmpDir, "relocated-trajectories");
    const relocatedTrajectoryPath = path.join(relocatedDir, "session-one.jsonl");
    fs.mkdirSync(relocatedDir, { recursive: true });
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
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

  it("tails SQLite marker trajectory rows from the database", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry(sessionKey, {
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-one",
        storePath,
      }),
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "sqlite", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("sqlite ok");
    expect(output).not.toContain("No sessions found");
    expect(fs.existsSync(path.join(tmpDir, "trajectory", "session-one.jsonl"))).toBe(false);
  });

  it("ignores stale trajectory pointers for another session id", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    const sessionFile = path.join(tmpDir, "session-one.jsonl");
    const staleRuntimePath = path.join(tmpDir, "relocated-trajectories", "old-session.jsonl");
    fs.writeFileSync(
      resolveTrajectoryPointerFilePath(sessionFile),
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "old-session",
        runtimeFile: staleRuntimePath,
      })}\n`,
    );
    writeJsonl(staleRuntimePath, [
      makeEvent({
        sessionId: "old-session",
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "stale", success: true },
      }),
    ]);
    await appendEvents([
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:22.000Z",
        data: { name: "current", success: true },
      }),
    ]);

    await sessionsTailCommand({ store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("current ok");
    expect(output).not.toContain("stale ok");
  });

  it("preserves events appended while follow mode starts", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" })]);
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

  it("delivers appended events across short follow reads without skipping bytes", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const appendedEvent = makeEvent({
      sourceSeq: 2,
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "python", success: true },
    });
    // POSIX positional reads may return fewer bytes than requested; cap each
    // call to prove the bounded delta is filled without skipping bytes.
    let capReads = false;
    let shortReadCalls = 0;
    const realReadSync = fs.readSync.bind(fs);
    const cappedReadSync = (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: fs.ReadPosition | null,
    ): number => {
      const cappedLength = capReads ? Math.min(length, 16) : length;
      if (capReads) {
        shortReadCalls += 1;
      }
      return realReadSync(fd, buffer, offset, cappedLength, position);
    };
    const readSpy = vi
      .spyOn(fs, "readSync")
      .mockImplementation(cappedReadSync as typeof fs.readSync);
    let appended = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!appended && String(message).includes("session.started")) {
        appended = true;
        capReads = true;
        appendJsonl(trajectoryPath, appendedEvent);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "python ok");
    } finally {
      readSpy.mockRestore();
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(shortReadCalls).toBeGreaterThan(1);
    expect(output).toContain("tool.result");
    expect(output).toContain("python ok");
  });

  it("continues following when later trajectory events are appended", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
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
        appendJsonl(trajectoryPath, rewrittenEvent);
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

  it("preserves UTF-8 characters split across follow reads", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const appendedEvent = makeEvent({
      sourceSeq: 2,
      type: "prompt.skipped",
      ts: "2026-05-18T12:04:21.000Z",
      data: { reason: "猫" },
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "session.started");
      const line = Buffer.from(`${JSON.stringify(appendedEvent)}\n`, "utf8");
      const marker = Buffer.from("猫", "utf8");
      const markerOffset = line.indexOf(marker);
      expect(markerOffset).toBeGreaterThanOrEqual(0);

      fs.appendFileSync(trajectoryPath, line.subarray(0, markerOffset + 1));
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      fs.appendFileSync(trajectoryPath, line.subarray(markerOffset + 1));
      await waitForRuntimeOutput(runtime, "prompt skipped");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("prompt skipped: 猫");
    expect(output).not.toContain("�");
  });

  it("preserves UTF-8 characters split before follow starts", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await appendEvents([
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const appendedEvent = makeEvent({
      sourceSeq: 2,
      type: "prompt.skipped",
      ts: "2026-05-18T12:04:21.000Z",
      data: { reason: "猫" },
    });
    const line = Buffer.from(`${JSON.stringify(appendedEvent)}\n`, "utf8");
    const markerOffset = line.indexOf(Buffer.from("猫", "utf8"));
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    fs.appendFileSync(trajectoryPath, line.subarray(0, markerOffset + 1));

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "session.started");
      fs.appendFileSync(trajectoryPath, line.subarray(markerOffset + 1));
      await waitForRuntimeOutput(runtime, "prompt skipped");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("prompt skipped: 猫");
    expect(output).not.toContain("�");
  });

  it("resets split UTF-8 state when the followed file is replaced", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    const startedEvent = makeEvent({
      sourceSeq: 1,
      type: "session.started",
      ts: "2026-05-18T12:04:17.000Z",
    });
    await appendEvents([startedEvent]);

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "session.started");
      const partialLine = Buffer.from(
        `${JSON.stringify(
          makeEvent({
            sourceSeq: 2,
            type: "prompt.skipped",
            ts: "2026-05-18T12:04:20.000Z",
            data: { reason: "猫" },
          }),
        )}\n`,
        "utf8",
      );
      const markerOffset = partialLine.indexOf(Buffer.from("猫", "utf8"));
      expect(markerOffset).toBeGreaterThanOrEqual(0);
      fs.appendFileSync(trajectoryPath, partialLine.subarray(0, markerOffset + 1));
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      const replacementPath = `${trajectoryPath}.replacement`;
      writeJsonl(replacementPath, [
        startedEvent,
        makeEvent({
          sourceSeq: 3,
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "rotation", success: true },
        }),
      ]);
      fs.renameSync(replacementPath, trajectoryPath);
      await waitForRuntimeOutput(runtime, "rotation ok");

      appendJsonl(
        trajectoryPath,
        makeEvent({
          sourceSeq: 4,
          type: "prompt.skipped",
          ts: "2026-05-18T12:04:22.000Z",
          data: { reason: "clean" },
        }),
      );
      await waitForRuntimeOutput(runtime, "prompt skipped: clean");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    expect(runtimeOutput(runtime)).not.toContain("�");
  });

  it("continues following when SQLite trajectory rows are appended", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry(sessionKey, {
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-one",
        storePath,
      }),
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
      makeEvent({
        sourceSeq: 1,
        type: "session.started",
        ts: "2026-05-18T12:04:17.000Z",
      }),
    ]);
    const appendedEvent = makeEvent({
      sourceSeq: 2,
      type: "tool.result",
      ts: "2026-05-18T12:04:21.000Z",
      data: { name: "sqlite", success: true },
    });
    let appended = false;
    vi.mocked(runtime.log).mockImplementation((message) => {
      if (!appended && String(message).includes("session.started")) {
        appended = true;
        appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
          appendedEvent,
        ]);
      }
    });

    const run = sessionsTailCommand(
      { store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await waitForRuntimeOutput(runtime, "sqlite ok");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("sqlite ok");
  });

  it("resolves the target store from a fully qualified non-default agent session key", async () => {
    const runtime = makeRuntime();
    const opsSessionKey = "agent:ops:telegram:direct:owner";
    const opsSessionsDir = path.join(process.env.OPENCLAW_STATE_DIR!, "agents", "ops", "sessions");
    const opsStorePath = path.join(opsSessionsDir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey: opsSessionKey, storePath: opsStorePath },
      { sessionId: "ops-session", sessionFile: "ops-session.jsonl", updatedAt: 3, status: "done" },
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

  it("rejects oversized trajectory snapshots", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    fs.writeFileSync(trajectoryPath, "");
    fs.truncateSync(trajectoryPath, TRAJECTORY_RUNTIME_FILE_MAX_BYTES + 1);

    await expect(sessionsTailCommand({ store: storePath, sessionKey }, runtime)).rejects.toThrow(
      /File exceeds 52428800 bytes/,
    );
  });

  it("rejects oversized follow-mode trajectory deltas", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    writeJsonl(trajectoryPath, [
      makeEvent({ type: "session.started", ts: "2026-05-18T12:04:17.000Z" }),
    ]);

    const run = sessionsTailCommand({ store: storePath, sessionKey, follow: true }, runtime);
    try {
      await waitForRuntimeOutput(runtime, "session.started");
      const initialSize = fs.statSync(trajectoryPath).size;
      fs.truncateSync(trajectoryPath, initialSize + TRAJECTORY_RUNTIME_FILE_MAX_BYTES + 1);
      await vi.waitFor(() => {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Trajectory delta exceeds 52428800 bytes"),
        );
      });
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await run;
    }
  });
});

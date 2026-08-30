// Sessions tail tests cover transcript tailing, filtering, and session-store setup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { sessionsTailCommand } from "./sessions-tail.js";

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

function runtimeOutput(runtime: RuntimeEnv): string {
  return vi
    .mocked(runtime.log)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

describe("sessionsTailCommand", () => {
  let tmpDir: string;
  let storePath: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-tail-"));
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
    mocks.getRuntimeConfig.mockReturnValue({
      agents: {
        list: [{ id: "main" }, { id: "ops" }],
      },
    });
    storePath = path.join(tmpDir, "sessions.sqlite");
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await upsertSessionEntryCore(
      { sessionKey: key, storePath },
      {
        sessionId: "session-one",
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
    appendSqliteTrajectoryRuntimeEvents(
      {
        agentId: "main",
        sessionId: params.sessionId ?? "session-one",
        storePath,
      },
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

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey }, runtime);

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

  it.each([
    ["ASCII", "incident", "incident"],
    ["CJK", "中文", "中文"],
    ["combining accent", "e\u0301", "e\u0301"],
    ["joined emoji", "👩🏽‍💻", "👩🏽‍💻"],
    ["truncated emoji", `${"a".repeat(17)}👩🏽‍💻-incident`, `${"a".repeat(17)}…`],
  ])("keeps progress columns aligned with %s session keys", async (_name, suffix, displayed) => {
    const runtime = makeRuntime();
    const key = `agent:main:${suffix}`;
    await writeSessionEntry(key);
    await appendEvents(
      [
        makeEvent({
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "proof", success: true },
        }),
      ],
      { key },
    );

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey: key }, runtime);

    const line = runtimeOutput(runtime);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain(` agent:main:${displayed} `);
    expect(line).toContain("tool.result");
    expect(line.endsWith("proof ok")).toBe(true);
    const previewOffset = line.indexOf("proof ok");
    expect(visibleWidth(line.slice(0, previewOffset))).toBe(57);
  });

  it.each([
    ["CSI inside", "a\u001b[31mb", "custom\u001b[31m", "ab", "custom"],
    [
      "OSC inside",
      "a\u001b]8;;https://example.invalid/\u0007b",
      "custom\u001b]8;;https://example.invalid/\u0007",
      "ab",
      "custom",
    ],
    [
      "CSI beyond cutoff",
      `${"a".repeat(30)}\u001b[31m`,
      "custom.progress-long\u001b[31m",
      `${"a".repeat(18)}…`,
      "custom.progress…",
    ],
    [
      "OSC beyond cutoff",
      `${"a".repeat(30)}\u001b]8;;https://example.invalid/\u0007`,
      "custom.progress-long\u001b]8;;https://example.invalid/\u0007",
      `${"a".repeat(18)}…`,
      "custom.progress…",
    ],
  ])(
    "renders %s as plain progress labels",
    async (_name, suffix, type, displayed, displayedType) => {
      const runtime = makeRuntime();
      const key = `agent:main:${suffix}`;
      await writeSessionEntry(key);
      await appendEvents(
        [makeEvent({ type, ts: "2026-05-18T12:04:21.000Z", data: { name: "proof" } })],
        { key },
      );

      await sessionsTailCommand({ agent: "main", store: storePath, sessionKey: key }, runtime);

      const line = runtimeOutput(runtime);
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toContain("\u001b");
      expect(line).not.toContain("\u0007");
      expect(line).toContain(` ${displayedType} `);
      expect(line).toContain(` agent:main:${displayed} `);
      expect(line.endsWith(" proof")).toBe(true);
      expect(visibleWidth(line.slice(0, line.lastIndexOf(" proof") + 1))).toBe(57);
    },
  );

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

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey, tail: "2" }, runtime);

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

    await sessionsTailCommand(
      { agent: "main", store: storePath, sessionKey, tail: "9007199254740992" },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "--tail must be a non-negative integer, for example --tail 25.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("tails SQLite trajectory rows from the database", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-one", storePath }, [
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:21.000Z",
        data: { name: "sqlite", success: true },
      }),
    ]);

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("tool.result");
    expect(output).toContain("sqlite ok");
    expect(output).not.toContain("No sessions found");
  });

  it("isolates trajectory rows by session id", async () => {
    const runtime = makeRuntime();
    await writeSessionEntry();
    await writeSessionEntry("agent:main:old", { sessionId: "old-session" });
    await appendEvents(
      [
        makeEvent({
          sessionId: "old-session",
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "stale", success: true },
        }),
      ],
      { sessionId: "old-session" },
    );
    await appendEvents([
      makeEvent({
        type: "tool.result",
        ts: "2026-05-18T12:04:22.000Z",
        data: { name: "current", success: true },
      }),
    ]);

    await sessionsTailCommand({ agent: "main", store: storePath, sessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("current ok");
    expect(output).not.toContain("stale ok");
  });

  it("continues following when SQLite trajectory rows are appended", async () => {
    vi.useFakeTimers();
    const runtime = makeRuntime();
    await writeSessionEntry();
    appendSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-one", storePath }, [
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
        appendSqliteTrajectoryRuntimeEvents(
          { agentId: "main", sessionId: "session-one", storePath },
          [appendedEvent],
        );
      }
    });

    const run = sessionsTailCommand(
      { agent: "main", store: storePath, sessionKey, tail: "1", follow: true },
      runtime,
    );
    try {
      await vi.advanceTimersByTimeAsync(1_000);
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
    await upsertSessionEntryCore(
      { sessionKey: opsSessionKey, storePath: opsStorePath },
      { sessionId: "ops-session", updatedAt: 3, status: "done" },
    );
    appendSqliteTrajectoryRuntimeEvents(
      { agentId: "ops", sessionId: "ops-session", storePath: opsStorePath },
      [
        makeEvent({
          sessionId: "ops-session",
          sessionKey: opsSessionKey,
          type: "tool.result",
          ts: "2026-05-18T12:04:21.000Z",
          data: { name: "bash", success: true },
        }),
      ],
    );

    await sessionsTailCommand({ sessionKey: opsSessionKey }, runtime);

    const output = runtimeOutput(runtime);
    expect(output).toContain("agent:ops:telegram:direct:own…");
    expect(output).toContain("tool.result");
    expect(output).toContain("bash ok");
    expect(output).not.toContain("No sessions found");
  });
});

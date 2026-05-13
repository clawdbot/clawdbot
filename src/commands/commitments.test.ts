import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { stripAnsi } from "../terminal/ansi.js";
import { commitmentsDismissCommand, commitmentsListCommand } from "./commitments.js";

const mocks = vi.hoisted(() => ({
  listCommitments: vi.fn(),
  markCommitmentsStatus: vi.fn(),
  resolveCommitmentStorePath: vi.fn(() => "/tmp/openclaw-commitments.json"),
  getRuntimeConfig: vi.fn(() => ({
    commitments: {
      enabled: true,
    },
  })),
}));

vi.mock("../commitments/store.js", () => ({
  listCommitments: mocks.listCommitments,
  markCommitmentsStatus: mocks.markCommitmentsStatus,
  resolveCommitmentStorePath: mocks.resolveCommitmentStorePath,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

function createRuntime(): { runtime: OutputRuntimeEnv; logs: string[]; stdout: string[] } {
  const logs: string[] = [];
  const stdout: string[] = [];
  return {
    logs,
    stdout,
    runtime: {
      log: (message: unknown) => logs.push(String(message)),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: (value: string) => stdout.push(value),
      writeJson: (value: unknown, space = 2) =>
        stdout.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    },
  };
}

function commitment(overrides?: Partial<CommitmentRecord>): CommitmentRecord {
  return {
    id: "cm_escape",
    agentId: "main\u001b[31m",
    sessionKey: "agent:main:session\u001b]8;;https://example.test\u0007",
    channel: "telegram",
    to: "+15551234567\u001b[0m",
    kind: "event_check_in",
    sensitivity: "routine",
    source: "inferred_user_context",
    status: "pending",
    reason: "The user mentioned an interview.",
    suggestedText: "How did it go?\u001b]52;c;YWJj\u0007\nspoofed",
    dedupeKey: "interview:2026-04-30",
    confidence: 0.91,
    dueWindow: {
      earliestMs: Date.parse("2026-04-30T17:00:00.000Z"),
      latestMs: Date.parse("2026-04-30T23:00:00.000Z"),
      timezone: "America/Los_Angeles",
    },
    createdAtMs: Date.parse("2026-04-29T16:00:00.000Z"),
    updatedAtMs: Date.parse("2026-04-29T16:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}

describe("commitments command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCommitments.mockResolvedValue([commitment()]);
  });

  it("sanitizes untrusted commitment fields in table output", async () => {
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    expect(logs.map(stripAnsi)).toEqual([
      "Commitments: 1",
      "Store: /tmp/openclaw-commitments.json",
      "Status filter: pending",
      "ID               Status     Kind             Due                      Scope                        Suggested text",
      "cm_escape        pending    event_check_in   2026-04-30T17:00:00.000Z main/telegram/+15551234567   How did it go?\\nspoofed",
    ]);
  });

  it("writes list JSON to runtime stdout instead of log output", async () => {
    const { runtime, logs, stdout } = createRuntime();

    await commitmentsListCommand({ json: true }, runtime);

    expect(logs).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({
      count: 1,
      status: "pending",
      agentId: null,
      store: "/tmp/openclaw-commitments.json",
      commitments: [{ id: "cm_escape" }],
    });
  });

  it("writes dismiss JSON to runtime stdout instead of log output", async () => {
    const { runtime, logs, stdout } = createRuntime();

    await commitmentsDismissCommand({ ids: ["cm_escape"], json: true }, runtime);

    expect(logs).toEqual([]);
    expect(stdout).toEqual([JSON.stringify({ dismissed: ["cm_escape"] }, null, 2)]);
    expect(mocks.markCommitmentsStatus).toHaveBeenCalledWith({
      cfg: { commitments: { enabled: true } },
      ids: ["cm_escape"],
      status: "dismissed",
      nowMs: expect.any(Number),
    });
  });
});

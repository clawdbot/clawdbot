import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitmentRecord } from "../commitments/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { commitmentsListCommand } from "./commitments.js";

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

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    runtime: {
      log: (message: unknown) => logs.push(String(message)),
      error: vi.fn(),
      exit: vi.fn(),
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
    sourceUserText: "I have an interview tomorrow.",
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

    const output = logs.join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toContain("\\nspoofed");
  });
});

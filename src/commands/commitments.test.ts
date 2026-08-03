// Commitments command tests cover commitment list/detail output and terminal formatting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { commitmentsDismissCommand, commitmentsListCommand } from "./commitments.js";

const mocks = vi.hoisted(() => ({
  listCommitments: vi.fn(),
  markCommitmentsStatus: vi.fn(),
  resolveCommitmentDatabasePath: vi.fn(() => "/tmp/openclaw.sqlite"),
}));

vi.mock("../commitments/store.js", () => ({
  listCommitments: mocks.listCommitments,
  markCommitmentsStatus: mocks.markCommitmentsStatus,
  resolveCommitmentDatabasePath: mocks.resolveCommitmentDatabasePath,
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
    mocks.markCommitmentsStatus.mockResolvedValue(["cm_escape"]);
  });

  it("sanitizes invalid status values before rendering errors", async () => {
    const { runtime } = createRuntime();

    await commitmentsListCommand(
      { status: "bad\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes\u001b[31m" },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Unknown commitment status: bad\\nforged: yes. Use one of: pending, sent, dismissed, snoozed, expired.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.listCommitments).not.toHaveBeenCalled();
  });

  it("sanitizes agent filters and database paths in human-readable output", async () => {
    const unsafeText = "\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes\u001b[31m";
    mocks.resolveCommitmentDatabasePath.mockReturnValueOnce(`/tmp/${unsafeText}.sqlite`);
    mocks.listCommitments.mockResolvedValueOnce([]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({ agent: `main${unsafeText}` }, runtime);

    expect(logs.map(stripAnsi)).toContain("Store: /tmp/\\nforged: yes.sqlite");
    expect(logs.map(stripAnsi)).toContain("Agent filter: main\\nforged: yes");
    for (const line of logs) {
      expect(line).not.toContain("\u0007");
      expect(line).not.toContain("\n");
    }
  });

  it("sanitizes untrusted commitment fields in table output", async () => {
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    expect(logs.map(stripAnsi)).toEqual([
      "Commitments: 1",
      "Store: /tmp/openclaw.sqlite",
      "Status filter: pending",
      "ID               Status     Kind             Due                      Scope                        Suggested text",
      "cm_escape        pending    event_check_in   2026-04-30T17:00:00.000Z main/telegram/+15551234567   How did it go?\\nspoofed",
    ]);
  });

  it("tolerates Date-invalid commitment due timestamps in table output", async () => {
    mocks.listCommitments.mockResolvedValue([
      commitment({
        dueWindow: {
          earliestMs: 8_700_000_000_000_000,
          latestMs: 8_700_000_000_000_000,
          timezone: "UTC",
        },
      }),
    ]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    expect(logs.map(stripAnsi)).toContain(
      "cm_escape        pending    event_check_in   n/a                      main/telegram/+15551234567   How did it go?\\nspoofed",
    );
  });

  it("keeps fixed-width columns aligned when an id or scope is truncated", async () => {
    // An id longer than the 16-char ID column and a scope longer than the
    // 28-char Scope column, so truncate() fires for both cells.
    mocks.listCommitments.mockResolvedValue([
      commitment({
        id: "cm_abcdefghijklmnopqrstuvwxyz", // 29 chars > 16
        agentId: "averylongagentidentifier",
        channel: "telegram",
        to: "+15551234567890", // agentId/channel/to joined > 28 chars
      }),
    ]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    const lines = logs.map(stripAnsi);
    const header = lines.find((line) => line.startsWith("ID"));
    const row = lines.find((line) => line.startsWith("cm_"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();

    // The truncated ID cell must stay within its 16-char column: 15 chars of
    // content plus a single-character ellipsis, not a 3-char "..." that overflows.
    expect(row?.slice(0, 16)).toBe("cm_abcdefghijkl…");

    // With each truncated cell at its intended width, the following columns line
    // up with the header. A 3-char "..." pushes every column after a truncated
    // cell 2 chars right of its header label.
    expect(row?.indexOf("pending")).toBe(header?.indexOf("Status"));
    expect(row?.indexOf("event_check_in")).toBe(header?.indexOf("Kind"));
  });

  it("keeps the Scope column aligned when only the scope is truncated", async () => {
    // Short id (untouched) but a scope longer than its 28-char column, so only
    // the scope cell is truncated. Isolates the second truncation site.
    mocks.listCommitments.mockResolvedValue([
      commitment({
        id: "cm_short", // 8 chars, fits the ID column untouched
        agentId: "averylongagentidentifier",
        channel: "telegram",
        to: "+15551234567890", // joined scope exceeds 28 chars
      }),
    ]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    const lines = logs.map(stripAnsi);
    const header = lines.find((line) => line.startsWith("ID"));
    const row = lines.find((line) => line.startsWith("cm_"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();

    // The short id is rendered in full (no ellipsis).
    expect(row?.slice(0, 16)).toBe("cm_short        ");

    // The 28-char Scope cell ends in a single-char ellipsis and holds its width,
    // so the trailing Suggested text column still begins under its header label.
    const scopeCell = row?.slice(70, 98);
    expect(scopeCell?.length).toBe(28);
    expect(scopeCell?.endsWith("…")).toBe(true);
    expect(row?.indexOf("How did it go?")).toBe(header?.indexOf("Suggested text"));
  });

  it("does not truncate an id that exactly fills the ID column", async () => {
    // 16 chars == maxChars, so value.length <= maxChars and the id passes through
    // whole with no ellipsis. Guards the boundary so we never over-truncate.
    mocks.listCommitments.mockResolvedValue([commitment({ id: "cm_exactly16char" })]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    const lines = logs.map(stripAnsi);
    const header = lines.find((line) => line.startsWith("ID"));
    const row = lines.find((line) => line.startsWith("cm_"));
    expect(row?.slice(0, 16)).toBe("cm_exactly16char");
    expect(row).not.toContain("…");
    expect(row?.indexOf("pending")).toBe(header?.indexOf("Status"));
  });

  it("truncates an id one character past the column width to a single ellipsis", async () => {
    // 17 chars == maxChars + 1, so truncate fires: 15 chars of content plus one
    // ellipsis == 16, holding the column (the old "..." produced 18 and overflowed).
    mocks.listCommitments.mockResolvedValue([commitment({ id: "cm_0123456789abcd" })]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    const lines = logs.map(stripAnsi);
    const header = lines.find((line) => line.startsWith("ID"));
    const row = lines.find((line) => line.startsWith("cm_"));
    expect(row?.slice(0, 16)).toBe("cm_0123456789ab…");
    expect(row?.indexOf("pending")).toBe(header?.indexOf("Status"));
  });

  it("keeps truncated table cells UTF-16 well-formed", async () => {
    mocks.listCommitments.mockResolvedValue([commitment({ id: `${"x".repeat(14)}🚀tail` })]);
    const { runtime, logs } = createRuntime();

    await commitmentsListCommand({}, runtime);

    const row = logs.map(stripAnsi).find((line) => line.startsWith("x"));
    expect(row?.slice(0, 16)).toBe(`${"x".repeat(14)}… `);
    expect(row).not.toContain("\uD83D");
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
      store: "/tmp/openclaw.sqlite",
      commitments: [{ id: "cm_escape" }],
    });
  });

  it("writes dismiss JSON to runtime stdout instead of log output", async () => {
    const { runtime, logs, stdout } = createRuntime();

    await commitmentsDismissCommand({ ids: ["cm_escape"], json: true }, runtime);

    expect(logs).toEqual([]);
    expect(stdout).toEqual([JSON.stringify({ dismissed: ["cm_escape"] }, null, 2)]);
    expect(mocks.markCommitmentsStatus).toHaveBeenCalledWith({
      ids: ["cm_escape"],
      status: "dismissed",
      nowMs: expect.any(Number),
    });
  });

  it("reports only actually dismissed ids and explains skipped ids", async () => {
    mocks.markCommitmentsStatus.mockResolvedValueOnce(["cm_valid"]);
    const { runtime, logs } = createRuntime();

    await commitmentsDismissCommand(
      { ids: [" cm_valid ", "cm_missing", "cm_valid", "cm_terminal"] },
      runtime,
    );

    expect(mocks.markCommitmentsStatus).toHaveBeenCalledWith({
      ids: ["cm_valid", "cm_missing", "cm_terminal"],
      status: "dismissed",
      nowMs: expect.any(Number),
    });
    expect(logs.map(stripAnsi)).toEqual(["Dismissed commitments: cm_valid"]);
    expect(runtime.error).toHaveBeenCalledWith(
      "Commitments not found or no longer active: cm_missing, cm_terminal. Run openclaw commitments --all to inspect current state.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects dismissals when no requested commitment is active", async () => {
    mocks.markCommitmentsStatus.mockResolvedValueOnce([]);
    const { runtime, logs } = createRuntime();

    await commitmentsDismissCommand({ ids: ["cm_missing", "cm_terminal"] }, runtime);

    expect(logs).toEqual([]);
    expect(runtime.error).toHaveBeenCalledWith(
      "Commitments not found or no longer active: cm_missing, cm_terminal. Run openclaw commitments --all to inspect current state.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps unsuccessful dismissals truthful and machine-readable", async () => {
    mocks.markCommitmentsStatus.mockResolvedValueOnce([]);
    const { runtime, logs, stdout } = createRuntime();

    await commitmentsDismissCommand({ ids: ["cm_missing"], json: true }, runtime);

    expect(logs).toEqual([]);
    expect(stdout).toEqual([
      JSON.stringify({ dismissed: [], notDismissed: ["cm_missing"] }, null, 2),
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("sanitizes dismissed ids in human output while preserving raw JSON", async () => {
    const unsafeId = "cm_\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes\u001b[31m";
    mocks.markCommitmentsStatus.mockResolvedValue([unsafeId]);
    const human = createRuntime();
    const json = createRuntime();

    await commitmentsDismissCommand({ ids: [unsafeId] }, human.runtime);
    await commitmentsDismissCommand({ ids: [unsafeId], json: true }, json.runtime);

    expect(human.logs.map(stripAnsi)).toEqual(["Dismissed commitments: cm_\\nforged: yes"]);
    expect(human.logs[0]).not.toContain("\u0007");
    expect(human.logs[0]).not.toContain("\n");
    expect(JSON.parse(json.stdout[0] ?? "{}")).toStrictEqual({ dismissed: [unsafeId] });
  });

  it("sanitizes skipped dismiss ids in human-readable failure output", async () => {
    const unsafeId = "cm_\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes\u001b[31m";
    mocks.markCommitmentsStatus.mockResolvedValueOnce([]);
    const { runtime } = createRuntime();

    await commitmentsDismissCommand({ ids: [unsafeId] }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Commitments not found or no longer active: cm_\\nforged: yes. Run openclaw commitments --all to inspect current state.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

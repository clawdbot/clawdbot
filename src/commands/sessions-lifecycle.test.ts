import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsArchiveCommand, sessionsDeleteCommand } from "./sessions-lifecycle.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

function listResult(
  sessions: Array<{ key: string; sessionId?: string; archived?: boolean }>,
  pagination: { hasMore?: boolean; nextOffset?: number | null } = {},
) {
  return { sessions, hasMore: false, nextOffset: null, ...pagination };
}

describe("sessions lifecycle commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(true);
  });

  it("archives through sessions.patch and emits the stable JSON envelope", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:work:scratch-1", sessionId: "session-1" }]))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:work:scratch-1",
        entry: { archivedAt: 123 },
      });
    const runtime = createRuntime();

    await sessionsArchiveCommand(
      {
        keys: ["agent:work:scratch-1"],
        agent: "work",
        url: "ws://gateway.test",
        token: "test-token",
        password: "test-password",
        timeout: "45000",
        json: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      1,
      "sessions.list",
      {
        url: "ws://gateway.test",
        token: "test-token",
        password: "test-password",
        timeout: "45000",
        json: true,
      },
      {
        limit: 200,
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
        agentId: "work",
      },
      { defaultTimeoutMs: 30_000 },
    );
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      "sessions.patch",
      expect.any(Object),
      {
        key: "agent:work:scratch-1",
        agentId: "work",
        expectedSessionId: "session-1",
        archived: true,
      },
      { defaultTimeoutMs: 10 * 60_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "archive",
        dryRun: false,
        results: [{ key: "agent:work:scratch-1", ok: true, status: "archived" }],
      },
      2,
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses sessions.list archived state for a mutation-free archive dry run", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      listResult([
        { key: "agent:main:active", sessionId: "active-session" },
        { key: "agent:main:archived", sessionId: "archived-session", archived: true },
      ]),
    );
    const runtime = createRuntime();

    await sessionsArchiveCommand(
      {
        keys: ["agent:main:active", "agent:main:archived"],
        dryRun: true,
        json: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "archive",
        dryRun: true,
        results: [
          { key: "agent:main:active", ok: true, status: "would_archive" },
          { key: "agent:main:archived", ok: true, status: "already_archived" },
        ],
      },
      2,
    );
  });

  it.each([
    ["archive", sessionsArchiveCommand, {}],
    ["delete", sessionsDeleteCommand, { yes: true }],
  ] as const)(
    "rejects a key-only listed session before %s mutation",
    async (_operation, command, options) => {
      mocks.callGateway.mockResolvedValueOnce(listResult([{ key: "agent:main:key-only" }]));
      const runtime = createRuntime();

      await command({ keys: ["agent:main:key-only"], ...options, json: true }, runtime);

      expect(mocks.callGateway).toHaveBeenCalledTimes(1);
      expect(mocks.callGateway.mock.calls[0]?.[0]).toBe("sessions.list");
      expect(runtime.writeJson).toHaveBeenCalledWith(
        {
          ok: false,
          operation: _operation,
          dryRun: false,
          results: [
            {
              key: "agent:main:key-only",
              ok: false,
              status: "failed",
              error: "Session has no durable identity; lifecycle mutation was not attempted.",
            },
          ],
        },
        2,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("deletes archived sessions with the same gated artifact contract as Control UI", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(
        listResult([{ key: "agent:main:archived", sessionId: "session-1", archived: true }]),
      )
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:archived",
        deleted: true,
        archived: ["/state/session-1.jsonl.deleted.123"],
        worktreePreserved: { id: "wt-1", branch: "scratch", path: "/worktree" },
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:archived"], yes: true, json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      "sessions.delete",
      expect.any(Object),
      {
        key: "agent:main:archived",
        expectedSessionId: "session-1",
        deleteTranscript: true,
        archivedOnly: true,
      },
      { defaultTimeoutMs: 30_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "delete",
        dryRun: false,
        results: [
          {
            key: "agent:main:archived",
            ok: true,
            status: "deleted",
            archived: ["/state/session-1.jsonl.deleted.123"],
            worktreePreserved: { id: "wt-1", branch: "scratch", path: "/worktree" },
          },
        ],
      },
      2,
    );
  });

  it("deletes active sessions without the archive-only scope restriction", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:main:active", sessionId: "session-1" }]))
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:active",
        deleted: true,
        archived: [],
      });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:active"], yes: true }, runtime);

    const deleteParams = mocks.callGateway.mock.calls[1]?.[2];
    expect(deleteParams).toEqual({
      key: "agent:main:active",
      expectedSessionId: "session-1",
      deleteTranscript: true,
    });
    expect(deleteParams).not.toHaveProperty("archivedOnly");
  });

  it("keeps delete dry runs read-only and does not require --yes", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      listResult([{ key: "agent:main:active", sessionId: "session-1" }]),
    );
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:active"], dryRun: true, json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "delete",
        dryRun: true,
        results: [{ key: "agent:main:active", ok: true, status: "would_delete" }],
      },
      2,
    );
  });

  it("refuses non-interactive deletion without --yes", async () => {
    mocks.callGateway.mockResolvedValueOnce(
      listResult([{ key: "agent:main:active", sessionId: "session-1" }]),
    );
    const runtime = createRuntime();
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      await sessionsDeleteCommand({ keys: ["agent:main:active"] }, runtime);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway.mock.calls[0]?.[0]).toBe("sessions.list");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --yes to delete non-interactively"),
    );
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("reports mixed valid and invalid keys in order and exits non-zero after continuing", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(
        listResult([
          { key: "agent:main:first", sessionId: "session-1" },
          { key: "agent:main:last", sessionId: "session-2" },
        ]),
      )
      .mockResolvedValueOnce({
        ok: true,
        key: "agent:main:first",
        deleted: true,
        archived: ["/state/session-1.jsonl.deleted.123"],
      })
      .mockRejectedValueOnce(new Error("session is still active"));
    const runtime = createRuntime();

    await sessionsDeleteCommand(
      {
        keys: ["agent:main:first", "agent:main:missing", "agent:main:last"],
        yes: true,
        json: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledTimes(3);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: false,
        operation: "delete",
        dryRun: false,
        results: [
          {
            key: "agent:main:first",
            ok: true,
            status: "deleted",
            archived: ["/state/session-1.jsonl.deleted.123"],
          },
          {
            key: "agent:main:missing",
            ok: false,
            status: "not_found",
            error: expect.stringContaining("openclaw sessions list --json"),
          },
          {
            key: "agent:main:last",
            ok: false,
            status: "failed",
            error: "session is still active",
          },
        ],
      },
      2,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("treats a delete race that reports deleted:false as not found", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([{ key: "agent:main:vanished", sessionId: "session-1" }]))
      .mockResolvedValueOnce({ ok: true, key: "agent:main:vanished", deleted: false });
    const runtime = createRuntime();

    await sessionsDeleteCommand({ keys: ["agent:main:vanished"], yes: true, json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: false,
        operation: "delete",
        dryRun: false,
        results: [
          {
            key: "agent:main:vanished",
            ok: false,
            status: "not_found",
            error: expect.stringContaining("choose a valid key"),
          },
        ],
      },
      2,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("paginates the UI list surface before declaring a key unknown", async () => {
    mocks.callGateway
      .mockResolvedValueOnce(listResult([], { hasMore: true, nextOffset: 200 }))
      .mockResolvedValueOnce(listResult([{ key: "agent:main:later", sessionId: "session-2" }]));
    const runtime = createRuntime();

    await sessionsArchiveCommand({ keys: ["agent:main:later"], dryRun: true, json: true }, runtime);

    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      "sessions.list",
      expect.any(Object),
      expect.objectContaining({ offset: 200 }),
      { defaultTimeoutMs: 30_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        operation: "archive",
        dryRun: true,
        results: [{ key: "agent:main:later", ok: true, status: "would_archive" }],
      },
      2,
    );
  });
});

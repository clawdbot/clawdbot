import { describe, expect, it, vi } from "vitest";
import { runSessionLifecycleBatch } from "./session-lifecycle-batch.js";

describe("session lifecycle batch", () => {
  it("preserves order, fences generations, and continues after target failures", async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.patchMany") {
        return {
          outcomes: [
            { ok: true, key: "agent:main:first" },
            {
              ok: false,
              key: "agent:main:bad",
              error: { code: "INVALID_REQUEST", message: "generation changed" },
            },
            { ok: true, key: "agent:main:last" },
          ],
        };
      }
      return { ok: true, key: params.key, deleted: true, archived: [] };
    });

    const results = await runSessionLifecycleBatch({
      operation: "delete",
      archiveBeforeDelete: true,
      items: [
        {
          key: "agent:main:first",
          target: {
            key: "agent:main:first",
            sessionId: "first-session",
            lifecycleRevision: "first-revision",
          },
        },
        {
          key: "agent:main:bad",
          target: { key: "agent:main:bad", sessionId: "bad-session" },
        },
        {
          key: "agent:main:last",
          target: { key: "agent:main:last", sessionId: "last-session" },
        },
      ],
      call: call as never,
    });

    expect(results.map((result) => result.status)).toEqual(["deleted", "failed", "deleted"]);
    expect(call).toHaveBeenCalledWith("sessions.patchMany", {
      targets: [
        {
          key: "agent:main:first",
          expectedSessionId: "first-session",
          expectedLifecycleRevision: "first-revision",
        },
        { key: "agent:main:bad", expectedSessionId: "bad-session" },
        { key: "agent:main:last", expectedSessionId: "last-session" },
      ],
      patch: { archived: true },
    });
    expect(call).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:first",
      expectedSessionId: "first-session",
      archivedOnly: true,
      deleteTranscript: true,
    });
    expect(call).not.toHaveBeenCalledWith(
      "sessions.delete",
      expect.objectContaining({ key: "agent:main:bad" }),
    );
  });

  it("never mutates a target without authoritative generation identity", async () => {
    const call = vi.fn();
    const results = await runSessionLifecycleBatch({
      operation: "archive",
      items: [{ key: "missing", target: { key: "missing" } }],
      call,
    });

    expect(call).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        key: "missing",
        ok: false,
        status: "failed",
        error: "Session generation identity is unavailable; refresh the session list and retry.",
      },
    ]);
  });

  it("keeps dry runs mutation-free", async () => {
    const call = vi.fn();
    const results = await runSessionLifecycleBatch({
      operation: "archive",
      dryRun: true,
      items: [
        { key: "active", target: { key: "active", sessionId: "active-session" } },
        {
          key: "archived",
          target: { key: "archived", sessionId: "archived-session", archived: true },
        },
      ],
      call,
    });

    expect(call).not.toHaveBeenCalled();
    expect(results.map((result) => result.status)).toEqual(["would_archive", "already_archived"]);
  });

  it("revalidates an already-archived target through sessions.patchMany", async () => {
    const call = vi.fn(async () => ({ outcomes: [{ ok: true, key: "archived" }] }));
    const results = await runSessionLifecycleBatch({
      operation: "archive",
      items: [
        {
          key: "archived",
          target: { key: "archived", sessionId: "archived-session", archived: true },
        },
      ],
      call: call as never,
    });

    expect(call).toHaveBeenCalledWith("sessions.patchMany", {
      targets: [{ key: "archived", expectedSessionId: "archived-session" }],
      patch: { archived: true },
    });
    expect(results).toEqual([{ key: "archived", ok: true, status: "already_archived" }]);
  });

  it("reports missing generation identity consistently in dry runs", async () => {
    const call = vi.fn();
    const results = await runSessionLifecycleBatch({
      operation: "delete",
      dryRun: true,
      items: [{ key: "missing", target: { key: "missing" } }],
      call,
    });

    expect(call).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        key: "missing",
        ok: false,
        status: "failed",
        error: "Session generation identity is unavailable; refresh the session list and retry.",
      },
    ]);
  });
});

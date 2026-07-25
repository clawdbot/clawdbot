import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import {
  abandonTaskSuggestionAcceptance,
  beginTaskSuggestionAcceptance,
} from "../task-suggestion-registry.js";
import { sessionsHandlers } from "./sessions.js";
import { taskSuggestionsHandlers } from "./task-suggestions.js";
import type { RespondFn } from "./types.js";

type Method =
  | "taskSuggestions.list"
  | "taskSuggestions.create"
  | "taskSuggestions.accept"
  | "taskSuggestions.dismiss";

async function call(method: Method, params: Record<string, unknown>) {
  const calls: Parameters<RespondFn>[] = [];
  const broadcast = vi.fn();
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  await taskSuggestionsHandlers[method]?.({
    params,
    respond,
    context: { broadcast, getRuntimeConfig: () => ({}) },
  } as never);
  return { response: calls[0], broadcast };
}

function requirePayload(result: Awaited<ReturnType<typeof call>>): unknown {
  expect(result.response?.[0]).toBe(true);
  if (!result.response?.[0]) {
    throw new Error("expected a successful gateway response");
  }
  return result.response[1];
}

async function dismissPendingTaskSuggestions(): Promise<void> {
  const listed = await call("taskSuggestions.list", {});
  const payload = requirePayload(listed) as { suggestions: Array<{ id: string }> };
  for (const suggestion of payload.suggestions) {
    await call("taskSuggestions.dismiss", { taskId: suggestion.id });
  }
}

beforeEach(dismissPendingTaskSuggestions);
afterEach(async () => {
  await dismissPendingTaskSuggestions();
  vi.restoreAllMocks();
});

describe("task suggestion gateway methods", () => {
  it("creates, lists, and resolves an ephemeral suggestion", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Remove stale adapter",
      prompt: "Delete src/example.ts and update its tests.",
      tldr: "The adapter is unreachable and adds maintenance cost.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
    });
    const payload = requirePayload(created) as { taskId: string };
    expect(payload.taskId).toMatch(/^task_/);
    expect(created.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      expect.objectContaining({
        action: "created",
        suggestion: expect.objectContaining({ agentId: "main" }),
      }),
      { dropIfSlow: true },
    );

    const listed = await call("taskSuggestions.list", {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(listed.response?.[1]).toMatchObject({
      suggestions: [{ id: payload.taskId, cwd: "/repo" }],
    });

    const resolved = await call("taskSuggestions.dismiss", {
      taskId: payload.taskId,
    });
    expect(resolved.response?.[1]).toEqual({ taskId: payload.taskId, dismissed: true });
    expect(resolved.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      { action: "resolved", taskId: payload.taskId, resolution: "dismissed" },
      { dropIfSlow: true },
    );

    const empty = await call("taskSuggestions.list", {});
    expect(empty.response?.[1]).toEqual({ suggestions: [] });
  });

  it("accepts a suggestion once and replays the created session key", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Remove stale adapter",
      prompt: "Delete src/example.ts and update its tests.",
      tldr: "The adapter is unreachable and adds maintenance cost.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    let sessionKey = "";
    const createSession = vi
      .spyOn(sessionsHandlers, "sessions.create")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toMatchObject({
          agentId: "main",
          parentSessionKey: "agent:main:main",
          label: "Remove stale adapter",
          task: "Delete src/example.ts and update its tests.",
          worktree: true,
          cwd: "/repo",
        });
        sessionKey = (params as { key: string }).key;
        expect(sessionKey).toMatch(/^agent:main:dashboard:/);
        respond(true, { key: sessionKey, runStarted: true }, undefined);
      });

    const first = await call("taskSuggestions.accept", { taskId });
    const retry = await call("taskSuggestions.accept", { taskId });

    expect(first.response?.[1]).toEqual({ taskId, key: sessionKey });
    expect(retry.response?.[1]).toEqual({ taskId, key: sessionKey });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(first.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      { action: "resolved", taskId, resolution: "accepted" },
      { dropIfSlow: true },
    );
  });

  it("coalesces concurrent acceptance requests", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createSession = vi
      .spyOn(sessionsHandlers, "sessions.create")
      .mockImplementation(async ({ params, respond }) => {
        await gate;
        respond(true, { key: (params as { key: string }).key, runStarted: true }, undefined);
      });

    const first = call("taskSuggestions.accept", { taskId });
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const second = call("taskSuggestions.accept", { taskId });
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.response?.[1]).toEqual(secondResult.response?.[1]);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("rolls back an empty session and keeps a failed seed suggestion pending", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    let sessionKey = "";
    vi.spyOn(sessionsHandlers, "sessions.create").mockImplementation(
      async ({ params, respond }) => {
        sessionKey = (params as { key: string }).key;
        respond(
          true,
          {
            key: sessionKey,
            runStarted: false,
            runError: { message: "provider unavailable" },
          },
          undefined,
        );
      },
    );
    const deleteSession = vi
      .spyOn(sessionsHandlers, "sessions.delete")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toEqual({
          key: sessionKey,
          agentId: "main",
          deleteTranscript: true,
          emitLifecycleHooks: false,
        });
        respond(true, { ok: true, deleted: true }, undefined);
      });

    const accepted = await call("taskSuggestions.accept", { taskId });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]).toMatchObject({ message: "provider unavailable" });
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(accepted.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      expect.objectContaining({
        action: "created",
        suggestion: expect.objectContaining({ id: taskId }),
      }),
      { dropIfSlow: true },
    );
    expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
  });

  it("rolls back a preallocated session when creation throws after persistence", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    let sessionKey = "";
    vi.spyOn(sessionsHandlers, "sessions.create").mockImplementation(async ({ params }) => {
      sessionKey = (params as { key: string }).key;
      throw new Error("initial dispatch failed");
    });
    const deleteSession = vi
      .spyOn(sessionsHandlers, "sessions.delete")
      .mockImplementation(async ({ params, respond }) => {
        expect(params).toMatchObject({ key: sessionKey, agentId: "main" });
        respond(true, { ok: true, deleted: true }, undefined);
      });

    const accepted = await call("taskSuggestions.accept", { taskId });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]).toMatchObject({ message: "initial dispatch failed" });
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(listed.response?.[1]).toMatchObject({ suggestions: [{ id: taskId }] });
  });

  it("expires a suggestion when partial session rollback cannot finish", async () => {
    const created = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const taskId = (requirePayload(created) as { taskId: string }).taskId;
    vi.spyOn(sessionsHandlers, "sessions.create").mockRejectedValue(
      new Error("initial dispatch failed"),
    );
    vi.spyOn(sessionsHandlers, "sessions.delete").mockImplementation(async ({ respond }) => {
      respond(false, undefined, { code: "UNAVAILABLE", message: "still active" });
    });
    vi.spyOn(managedWorktrees, "findLiveByOwner").mockReturnValue({ id: "wt_partial" } as never);
    vi.spyOn(managedWorktrees, "remove").mockRejectedValue(new Error("still active"));

    const accepted = await call("taskSuggestions.accept", { taskId });
    const listed = await call("taskSuggestions.list", {});

    expect(accepted.response?.[0]).toBe(false);
    expect(accepted.response?.[2]?.message).toContain("failed to roll back");
    expect(accepted.broadcast).toHaveBeenCalledWith(
      "task.suggestion",
      { action: "resolved", taskId, resolution: "expired" },
      { dropIfSlow: true },
    );
    expect(listed.response?.[1]).toEqual({ suggestions: [] });
  });

  it("rejects a relative cwd before recording or broadcasting", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "relative/repo",
      sessionKey: "agent:main:main",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({ message: "task suggestion cwd must be absolute" });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it("rejects an agent that conflicts with the source session", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "Add the missing regression test.",
      tldr: "The edge case is untested.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
      agentId: "work",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "task suggestion agentId must match its source session",
    });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it("rejects retained fields beyond their protocol limits", async () => {
    const result = await call("taskSuggestions.create", {
      title: "Add coverage",
      prompt: "x".repeat(32_769),
      tldr: "The edge case is untested.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
    });

    expect(result.response?.[0]).toBe(false);
    expect(result.response?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(result.broadcast).not.toHaveBeenCalled();
  });

  it("keeps the complete list below the retained payload budget", async () => {
    const taskIds: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Follow up ${index}`,
        prompt: `${index}: ${"x".repeat(32_760)}`,
        tldr: "The follow-up remains useful.",
        cwd: "/repo",
        sessionKey: "agent:main:main",
      });
      taskIds.push((requirePayload(created) as { taskId: string }).taskId);
    }

    const listed = await call("taskSuggestions.list", {});
    const payload = requirePayload(listed) as { suggestions: Array<{ id: string }> };
    expect(Buffer.byteLength(JSON.stringify(payload.suggestions))).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(payload.suggestions.length).toBeLessThan(70);
    expect(payload.suggestions.some((suggestion) => suggestion.id === taskIds[0])).toBe(false);
  });

  it("broadcasts when the bounded registry expires a pending suggestion", async () => {
    const taskIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Follow up ${index}`,
        prompt: `Complete follow-up task ${index}.`,
        tldr: `Follow-up task ${index} remains useful.`,
        cwd: "/repo",
        sessionKey: "agent:main:main",
      });
      taskIds.push((requirePayload(created) as { taskId: string }).taskId);
    }

    const replacement = await call("taskSuggestions.create", {
      title: "Latest follow up",
      prompt: "Complete the latest follow-up task.",
      tldr: "The latest follow-up remains useful.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
    });

    expect(replacement.response?.[0]).toBe(true);
    expect(replacement.broadcast).toHaveBeenNthCalledWith(
      1,
      "task.suggestion",
      { action: "resolved", taskId: taskIds[0], resolution: "expired" },
      { dropIfSlow: true },
    );
    const listed = await call("taskSuggestions.list", {});
    expect((requirePayload(listed) as { suggestions: unknown[] }).suggestions).toHaveLength(100);
  });

  it("rejects a new suggestion when every bounded registry entry is accepting", async () => {
    const claimedTaskIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const created = await call("taskSuggestions.create", {
        title: `Follow up ${index}`,
        prompt: `Complete follow-up task ${index}.`,
        tldr: `Follow-up task ${index} remains useful.`,
        cwd: "/repo",
        sessionKey: "agent:main:main",
      });
      const taskId = (requirePayload(created) as { taskId: string }).taskId;
      expect(beginTaskSuggestionAcceptance(taskId).status).toBe("claimed");
      claimedTaskIds.push(taskId);
    }

    const rejected = await call("taskSuggestions.create", {
      title: "One too many",
      prompt: "Complete one more follow-up task.",
      tldr: "This follow-up can wait until capacity returns.",
      cwd: "/repo",
      sessionKey: "agent:main:main",
    });

    expect(rejected.response?.[0]).toBe(false);
    expect(rejected.response?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: "task suggestion registry is busy",
      retryable: true,
    });
    expect(rejected.broadcast).not.toHaveBeenCalled();

    for (const taskId of claimedTaskIds) {
      expect(abandonTaskSuggestionAcceptance(taskId)).toBe(true);
    }
  });
});

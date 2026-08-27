// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { persistSessionBoardFace } from "./chat-board-face-persistence.ts";

function contextWithSessions(sessions: Array<{ key: string; boardFace?: "chat" | "dashboard" }>) {
  const patch = vi.fn(async () => null);
  const context = {
    sessions: {
      state: { result: { sessions } },
      patch,
    },
  } as unknown as Pick<ApplicationContext, "sessions">;
  return { context, patch };
}

describe("persistSessionBoardFace", () => {
  it("skips the patch when an equivalent cached row already has the requested face", () => {
    const { context, patch } = contextWithSessions([{ key: "main", boardFace: "dashboard" }]);

    persistSessionBoardFace(context, "agent:main:main", "dashboard");

    expect(patch).not.toHaveBeenCalled();
  });

  it("patches a native session when the cached face differs", () => {
    const { context, patch } = contextWithSessions([
      { key: "agent:work:thread", boardFace: "chat" },
    ]);

    persistSessionBoardFace(context, "agent:work:thread", "dashboard");

    expect(patch).toHaveBeenCalledWith(
      "agent:work:thread",
      { boardFace: "dashboard" },
      { agentId: "work" },
    );
  });

  it("does not patch synthetic catalog sessions", () => {
    const { context, patch } = contextWithSessions([]);

    persistSessionBoardFace(context, "catalog:codex:gateway%3Alocal:thread-1", "dashboard");

    expect(patch).not.toHaveBeenCalled();
  });
});

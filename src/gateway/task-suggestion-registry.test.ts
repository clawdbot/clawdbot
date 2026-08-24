import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

const BASE_SUGGESTION = {
  title: "Follow up",
  prompt: "Complete the follow-up task.",
  tldr: "The follow-up remains useful.",
  cwd: process.cwd(),
  sessionKey: "agent:main:main",
  agentId: "main",
};

describe("task suggestion registry", () => {
  it("evicts accepted replay before pending work", async () => {
    const {
      beginTaskSuggestionAcceptance,
      completeTaskSuggestionAcceptance,
      createTaskSuggestion,
      listTaskSuggestions,
    } = await importFreshModule<typeof import("./task-suggestion-registry.js")>(
      import.meta.url,
      "./task-suggestion-registry.js?scope=eviction-priority",
    );
    const accepted = createTaskSuggestion(BASE_SUGGESTION);
    expect(accepted.status).toBe("created");
    if (accepted.status !== "created") {
      throw new Error("expected accepted suggestion admission");
    }
    expect(beginTaskSuggestionAcceptance(accepted.suggestion.id).status).toBe("claimed");
    completeTaskSuggestionAcceptance(accepted.suggestion.id, "agent:main:dashboard:accepted");

    let oldestPendingTaskId = "";
    for (let index = 0; index < 99; index += 1) {
      const pending = createTaskSuggestion({
        ...BASE_SUGGESTION,
        title: `Pending follow up ${index}`,
      });
      expect(pending.status).toBe("created");
      if (pending.status === "created" && index === 0) {
        oldestPendingTaskId = pending.suggestion.id;
      }
    }

    const replacement = createTaskSuggestion({
      ...BASE_SUGGESTION,
      title: "Latest follow up",
    });

    expect(replacement).toMatchObject({ status: "created", evictedPendingSuggestions: [] });
    expect(beginTaskSuggestionAcceptance(accepted.suggestion.id)).toEqual({ status: "missing" });
    expect(listTaskSuggestions({}).map((suggestion) => suggestion.id)).toContain(
      oldestPendingTaskId,
    );
  });
});

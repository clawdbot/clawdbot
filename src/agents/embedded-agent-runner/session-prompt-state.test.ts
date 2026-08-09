import { afterEach, describe, expect, it } from "vitest";
import {
  clearEmbeddedSessionPromptStates,
  prepareEmbeddedSessionActiveProjectKeys,
} from "./session-prompt-state.js";

const sessionIds = new Set<string>();

function prepare(sessionId: string, projectKey: string | null): readonly string[] {
  sessionIds.add(sessionId);
  return prepareEmbeddedSessionActiveProjectKeys(sessionId, projectKey);
}

afterEach(() => {
  clearEmbeddedSessionPromptStates(sessionIds);
  sessionIds.clear();
});

describe("embedded session active project keys", () => {
  it("promotes repeated keys while retaining other recently active projects", () => {
    expect(prepare("session-lru", "repo-a")).toEqual(["repo-a"]);
    expect(prepare("session-lru", "repo-b")).toEqual(["repo-b", "repo-a"]);
    expect(prepare("session-lru", "repo-a")).toEqual(["repo-a", "repo-b"]);
  });

  it("evicts the least-recent project beyond the four-key cap", () => {
    for (const key of ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"]) {
      prepare("session-cap", key);
    }
    expect(prepare("session-cap", null)).toEqual(["repo-e", "repo-d", "repo-c", "repo-b"]);
  });

  it("keeps single-repository sessions identical and isolated", () => {
    expect(prepare("session-one", "repo-a")).toEqual(["repo-a"]);
    expect(prepare("session-one", null)).toEqual(["repo-a"]);
    expect(prepare("session-two", null)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadNewSessionPreference, patchNewSessionPreference } from "./preferences.ts";

describe("new-session browser preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  it("keeps selections isolated by Gateway and agent", () => {
    patchNewSessionPreference("ws://one.example", "Main", {
      workspace: "/workspace",
      folder: "/workspace/project",
      worktree: true,
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "high",
    });

    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      workspace: "/workspace",
      folder: "/workspace/project",
      worktree: true,
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "high",
    });
    expect(loadNewSessionPreference("ws://one.example", "research")).toBeNull();
    expect(loadNewSessionPreference("ws://two.example", "main")).toBeNull();
  });

  it("merges changes and drops malformed persisted fields", () => {
    patchNewSessionPreference("ws://one.example", "main", { folder: "/first" });
    patchNewSessionPreference("ws://one.example", "main", { worktree: false });

    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      folder: "/first",
      worktree: false,
    });

    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(
      key ?? "",
      JSON.stringify({ agents: { main: { folder: 42, model: [], worktree: "yes" } } }),
    );
    expect(loadNewSessionPreference("ws://one.example", "main")).toBeNull();
  });
});

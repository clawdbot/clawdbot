import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  decodeIdentityPreferences,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  patchNewSessionPreference,
  replaceBrowserPreference,
} from "./preferences.ts";

describe("new-session browser preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  it("keeps selections isolated by Gateway and agent", () => {
    patchNewSessionPreference("ws://one.example", "Main", {
      workspace: "/workspace",
      folder: "/workspace/project",
      where: { kind: "cloud", id: "build-fleet" },
      projectId: "openclaw",
      worktree: true,
      baseRef: "main",
      worktreeName: "picker-redesign",
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "high",
    });

    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      workspace: "/workspace",
      folder: "/workspace/project",
      where: { kind: "cloud", id: "build-fleet" },
      projectId: "openclaw",
      worktree: true,
      baseRef: "main",
      worktreeName: "picker-redesign",
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
      JSON.stringify({
        agents: {
          main: {
            folder: 42,
            where: { kind: "node", id: [] },
            projectId: {},
            model: [],
            worktree: "yes",
          },
        },
      }),
    );
    expect(loadNewSessionPreference("ws://one.example", "main")).toBeNull();
  });

  it("round-trips normalized browser preferences through identity keys", () => {
    patchNewSessionPreference("ws://one.example", "Main", { folder: "/local", worktree: true });
    const browser = loadBrowserPreferences("ws://one.example");
    expect(encodeIdentityPreferences(browser)).toEqual({
      "new-session.v1:main": { folder: "/local", worktree: true },
    });
    expect(
      decodeIdentityPreferences({
        unrelated: { folder: "/ignored" },
        "new-session.v1:main": { folder: "/gateway", model: "openai/test" },
      }),
    ).toEqual({ main: { folder: "/gateway", model: "openai/test" } });

    replaceBrowserPreference("ws://one.example", "main", { folder: "/gateway" });
    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      folder: "/gateway",
    });
  });
});

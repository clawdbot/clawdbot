// Coverage for attempt context path remapping.
import { describe, expect, it } from "vitest";
import { remapInjectedContextFilesToWorkspace } from "./attempt.bootstrap-context.js";

describe("remapInjectedContextFilesToWorkspace", () => {
  it("rewrites injected file paths onto the effective workspace when the tool root changes", () => {
    // Spawned/sandboxed workspaces preserve relative context file locations while
    // leaving outside-workspace references untouched.
    expect(
      remapInjectedContextFilesToWorkspace({
        files: [
          {
            path: "/real/workspace/AGENTS.md",
            content: "agents",
          },
          {
            path: "/real/workspace/nested/TOOLS.md",
            content: "tools",
          },
          {
            path: "/real/workspace/..context/USER.md",
            content: "dot-prefixed context",
          },
          {
            path: "/outside/README.md",
            content: "outside",
          },
        ],
        sourceWorkspaceDir: "/real/workspace",
        targetWorkspaceDir: "/sandbox/workspace",
      }),
    ).toEqual([
      {
        path: "/sandbox/workspace/AGENTS.md",
        content: "agents",
      },
      {
        path: "/sandbox/workspace/nested/TOOLS.md",
        content: "tools",
      },
      {
        path: "/sandbox/workspace/..context/USER.md",
        content: "dot-prefixed context",
      },
      {
        path: "/outside/README.md",
        content: "outside",
      },
    ]);
  });
});

// Coverage for attempt bootstrap ownership and context path remapping.
import { describe, expect, it } from "vitest";
import {
  isPrimaryBootstrapRun,
  remapInjectedContextFilesToWorkspace,
} from "./attempt.bootstrap-context.js";

describe("isPrimaryBootstrapRun", () => {
  it("treats regular sessions as primary bootstrap runs", () => {
    expect(isPrimaryBootstrapRun("agent:main:main")).toBe(true);
  });

  it("suppresses bootstrap ownership for subagent and ACP/helper sessions", () => {
    // Only the primary session owns bootstrap context; helper sessions inherit
    // context through their parent flow.
    expect(isPrimaryBootstrapRun("agent:main:subagent:worker")).toBe(false);
    expect(isPrimaryBootstrapRun("agent:main:acp:worker")).toBe(false);
  });
});

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

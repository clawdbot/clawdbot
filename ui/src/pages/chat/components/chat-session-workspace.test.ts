import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceProps,
  toggleSessionWorkspace,
  type SessionWorkspaceHost,
  workspaceBrowserFilePath,
} from "./chat-session-workspace.ts";

describe("toggleSessionWorkspace", () => {
  it("expands and collapses the session workspace rail", () => {
    const requestUpdate = vi.fn();
    const state = {
      client: null,
      connected: false,
      handleOpenSidebar: vi.fn(),
      hello: null,
      requestUpdate,
      sessionKey: "agent:main:current",
      sessions: {},
    } as unknown as SessionWorkspaceHost;

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);

    toggleSessionWorkspace(state);

    expect(createSessionWorkspaceProps(state).collapsed).toBe(false);

    toggleSessionWorkspace(state);

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("workspaceBrowserFilePath", () => {
  it("resolves browser rows from the workspace root", () => {
    expect(workspaceBrowserFilePath("/workspace", "src/readme.md")).toBe(
      "/workspace/src/readme.md",
    );
  });

  it("preserves Windows workspace separators", () => {
    expect(workspaceBrowserFilePath("C:\\workspace", "src/readme.md")).toBe(
      "C:\\workspace\\src\\readme.md",
    );
  });

  it("preserves the POSIX filesystem root", () => {
    expect(workspaceBrowserFilePath("/", "src/readme.md")).toBe("/src/readme.md");
  });
});

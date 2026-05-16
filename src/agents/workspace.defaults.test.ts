import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("uses OPENCLAW_HOME when resolving the default workspace dir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    vi.stubEnv("HOME", path.join(path.sep, "home", "other"));

    expect(resolveDefaultAgentWorkspaceDir()).toBe(
      path.join(path.resolve(home), ".openclaw", "workspace"),
    );
  });

  it("uses OPENCLAW_WORKSPACE_DIR before OPENCLAW_HOME", () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
    vi.stubEnv("OPENCLAW_HOME", path.join(path.sep, "srv", "openclaw-home"));

    expect(resolveDefaultAgentWorkspaceDir()).toBe(path.resolve(workspaceDir));
  });
});

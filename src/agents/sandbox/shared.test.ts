import { describe, expect, it } from "vitest";
import {
  buildSandboxContainerName,
  resolveSandboxWorkspaceLayoutPaths,
  slugifySessionKey,
} from "./shared.js";

describe("buildSandboxContainerName", () => {
  it("preserves scope identity when a custom prefix exceeds the Docker name limit", () => {
    const commonPrefix = "custom-prefix-".repeat(6);
    const first = buildSandboxContainerName(
      `${commonPrefix}first`,
      slugifySessionKey("session:first"),
    );
    const second = buildSandboxContainerName(
      `${commonPrefix}second`,
      slugifySessionKey("session:second"),
    );
    const sameScopeDifferentPrefix = buildSandboxContainerName(
      `${commonPrefix}second`,
      slugifySessionKey("session:first"),
    );
    const oversizedSlug = buildSandboxContainerName(
      commonPrefix,
      slugifySessionKey("session:".concat("x".repeat(200))),
    );

    expect(first).not.toBe(second);
    expect(first).not.toBe(sameScopeDifferentPrefix);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(oversizedSlug).toHaveLength(63);
    expect(first).toMatch(/-[0-9a-f]{12}$/);
    expect(second).toMatch(/-[0-9a-f]{12}$/);
    expect(oversizedSlug).toMatch(/-[0-9a-f]{12}$/);
  });

  it("preserves workspace identity when a custom prefix exceeds the Docker name limit", () => {
    const slug = slugifySessionKey(`agent:main:workspace:${"a".repeat(32)}`);
    const first = buildSandboxContainerName("custom-prefix-one-that-is-far-too-long-", slug);
    const second = buildSandboxContainerName("custom-prefix-two-that-is-far-too-long-", slug);

    expect(slug).toMatch(/^workspace-[a-f0-9]{32}$/);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(first).not.toBe(second);
    expect(first).toContain(slug);
    expect(second).toContain(slug);
    expect(first).toMatch(/-[a-f0-9]{12}$/);
    expect(second).toMatch(/-[a-f0-9]{12}$/);
  });
});

describe("resolveSandboxWorkspaceLayoutPaths", () => {
  const sessionKey = "agent:poly:msteams:channel-1";
  const workspaceA = "/tmp/openclaw-customers/atica/agents/poly/workspace";
  const workspaceB = "/tmp/openclaw-customers/polytopic/agents/poly/workspace";
  const createLayout = (scope: "session" | "agent" | "shared", workspaceDir: string) =>
    resolveSandboxWorkspaceLayoutPaths({
      cfg: {
        scope,
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
      },
      rawSessionKey: sessionKey,
      workspaceDir,
    });

  it.each(["session", "agent"] as const)("qualifies %s scope by resolved workspace", (scope) => {
    const first = createLayout(scope, workspaceA).scopeKey;
    const second = createLayout(scope, workspaceB).scopeKey;

    expect(first).toMatch(/:workspace:[a-f0-9]{32}$/);
    expect(second).toMatch(/:workspace:[a-f0-9]{32}$/);
    expect(first).not.toBe(second);
  });

  it("keeps shared scope independent of workspace", () => {
    expect(createLayout("shared", workspaceA).scopeKey).toBe("shared");
    expect(createLayout("shared", workspaceB).scopeKey).toBe("shared");
  });

  it("uses the prepared agent owner for a bare agent-scoped session key", () => {
    const layout = resolveSandboxWorkspaceLayoutPaths({
      cfg: {
        scope: "agent",
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
      },
      rawSessionKey: "global",
      agentId: "research",
      workspaceDir: workspaceA,
    });

    expect(layout.scopeKey).toMatch(/^agent:research:workspace:[a-f0-9]{32}$/);
  });
});

// Spawned context tests cover metadata cleanup and workspace inheritance for
// child runs launched from agent tools.
import { describe, expect, it } from "vitest";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSessionRun,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";

describe("normalizeSpawnedRunMetadata", () => {
  it("trims text fields and drops empties", () => {
    expect(
      normalizeSpawnedRunMetadata({
        spawnedBy: "  agent:main:subagent:1 ",
        groupId: "  group-1 ",
        groupChannel: "  slack ",
        groupSpace: " ",
        workspaceDir: " /tmp/ws ",
      }),
    ).toEqual({
      spawnedBy: "agent:main:subagent:1",
      groupId: "group-1",
      groupChannel: "slack",
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("mapToolContextToSpawnedRunMetadata", () => {
  it("maps agent group fields to run metadata shape", () => {
    expect(
      mapToolContextToSpawnedRunMetadata({
        agentGroupId: "g-1",
        agentGroupChannel: "telegram",
        agentGroupSpace: "topic:123",
        workspaceDir: "/tmp/ws",
      }),
    ).toEqual({
      groupId: "g-1",
      groupChannel: "telegram",
      groupSpace: "topic:123",
      workspaceDir: "/tmp/ws",
    });
  });
});

describe("resolveSpawnedWorkspaceInheritance", () => {
  // Workspace inheritance prefers explicit caller intent, then target agent
  // config, then requester context so child runs stay in the expected checkout.
  const config = {
    agents: {
      list: [
        { id: "main", workspace: "/tmp/workspace-main" },
        { id: "ops", workspace: "/tmp/workspace-ops" },
      ],
    },
  };

  it("prefers explicit workspaceDir when provided", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
      explicitWorkspaceDir: " /tmp/explicit ",
    });
    expect(resolved).toBe("/tmp/explicit");
  });

  it("prefers targetAgentId over requester session agent for cross-agent spawns", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      targetAgentId: "ops",
      requesterSessionKey: "agent:main:subagent:parent",
    });
    expect(resolved).toBe("/tmp/workspace-ops");
  });

  it("falls back to requester session agent when targetAgentId is missing", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: "agent:main:subagent:parent",
    });
    expect(resolved).toBe("/tmp/workspace-main");
  });

  it("returns undefined for missing requester context", () => {
    const resolved = resolveSpawnedWorkspaceInheritance({
      config,
      requesterSessionKey: undefined,
      explicitWorkspaceDir: undefined,
    });
    expect(resolved).toBeUndefined();
  });
});

describe("resolveIngressWorkspaceOverrideForSessionRun", () => {
  it("uses inherited workspaces for spawned runs and managed cwd for dashboard worktrees", () => {
    expect(
      resolveIngressWorkspaceOverrideForSessionRun({
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/ws",
        cwd: "/tmp/task",
      }),
    ).toBe("/tmp/ws");
    expect(
      resolveIngressWorkspaceOverrideForSessionRun({
        spawnedBy: "",
        workspaceDir: "/tmp/ws",
        cwd: "/tmp/worktree",
      }),
    ).toBe("/tmp/worktree");
    expect(resolveIngressWorkspaceOverrideForSessionRun()).toBeUndefined();
  });
});

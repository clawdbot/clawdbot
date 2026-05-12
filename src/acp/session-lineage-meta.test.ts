import { describe, expect, it } from "vitest";
import { toAcpSessionLineageMeta, type AcpSessionLineageRow } from "./session-lineage-meta.js";

describe("toAcpSessionLineageMeta", () => {
  it("keeps root session metadata minimal", () => {
    const meta = toAcpSessionLineageMeta({
      key: "agent:main:main",
      kind: "direct",
      channel: "telegram",
    });

    expect(meta).toEqual({
      sessionKey: "agent:main:main",
      kind: "direct",
      channel: "telegram",
    });
    expect(Object.keys(meta)).toEqual(["sessionKey", "kind", "channel"]);
  });

  it("maps a one-level child parent key into parentSessionId", () => {
    const meta = toAcpSessionLineageMeta({
      key: "agent:main:subagent:child",
      kind: "direct",
      parentSessionKey: "agent:main:main",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
    });

    expect(meta).toEqual({
      sessionKey: "agent:main:subagent:child",
      kind: "direct",
      parentSessionId: "agent:main:main",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
    });
  });

  it("keeps multi-level child lineage and workspace metadata", () => {
    const meta = toAcpSessionLineageMeta({
      key: "agent:main:subagent:parent:subagent:leaf",
      kind: "direct",
      parentSessionKey: "agent:main:subagent:parent",
      spawnedBy: "agent:main:subagent:parent",
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
      spawnedWorkspaceDir: "/workspace/leaf",
    });

    expect(meta).toEqual({
      sessionKey: "agent:main:subagent:parent:subagent:leaf",
      kind: "direct",
      parentSessionId: "agent:main:subagent:parent",
      spawnedBy: "agent:main:subagent:parent",
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
      spawnedWorkspaceDir: "/workspace/leaf",
    });
  });

  it("falls back to spawnedBy for parentSessionId when no explicit parent key is present", () => {
    expect(
      toAcpSessionLineageMeta({
        key: "agent:main:subagent:child",
        kind: "direct",
        spawnedBy: "agent:main:main",
      }),
    ).toEqual({
      sessionKey: "agent:main:subagent:child",
      kind: "direct",
      parentSessionId: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
  });

  it("omits malformed optional lineage values", () => {
    const row = {
      key: "agent:main:subagent:broken",
      kind: "direct",
      channel: "",
      parentSessionKey: " ",
      spawnedBy: 42,
      spawnDepth: 1.5,
      subagentRole: "worker",
      subagentControlScope: "all",
      spawnedWorkspaceDir: "",
    } as unknown as AcpSessionLineageRow;

    expect(toAcpSessionLineageMeta(row)).toEqual({
      sessionKey: "agent:main:subagent:broken",
      kind: "direct",
    });
  });
});

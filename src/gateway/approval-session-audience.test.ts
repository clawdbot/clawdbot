import { describe, expect, it } from "vitest";
import {
  resolveApprovalSessionAudienceFromSources,
  type ApprovalSessionAudienceSources,
} from "./approval-session-audience.js";

type GraphNode = {
  registry?: {
    controllerSessionKey?: string | null;
    requesterSessionKey?: string | null;
  };
  stored?: {
    parentSessionKey?: string;
    spawnedBy?: string;
  };
};

function resolveAudience(
  sourceSessionKey: string,
  graph: Record<string, GraphNode>,
  canonicalizeSessionKey: ApprovalSessionAudienceSources["canonicalizeSessionKey"] = (key) =>
    key.trim(),
): string[] {
  return resolveApprovalSessionAudienceFromSources({
    sourceSessionKey,
    sources: {
      canonicalizeSessionKey,
      getLatestSubagentLineage: (key) => graph[key]?.registry,
      getStoredSessionLineage: (key) => graph[key]?.stored,
    },
  });
}

describe("resolveApprovalSessionAudienceFromSources", () => {
  it("keeps the canonical source first when it has no ancestors", () => {
    expect(
      resolveAudience(" Child ", {}, (key) => `agent:main:${key.trim().toLowerCase()}`),
    ).toEqual(["agent:main:child"]);
  });

  it("walks registry controller and requester branches breadth-first", () => {
    const graph: Record<string, GraphNode> = {
      child: {
        registry: {
          controllerSessionKey: "controller",
          requesterSessionKey: "requester",
        },
        stored: { parentSessionKey: "stale-parent" },
      },
      controller: { stored: { parentSessionKey: "controller-root" } },
      requester: { stored: { parentSessionKey: "requester-root" } },
    };

    expect(resolveAudience("child", graph)).toEqual([
      "child",
      "controller",
      "requester",
      "controller-root",
      "requester-root",
    ]);
  });

  it("deduplicates canonical registry parents and suppresses stale stored lineage", () => {
    const graph: Record<string, GraphNode> = {
      child: {
        registry: {
          controllerSessionKey: "PARENT",
          requesterSessionKey: "parent",
        },
        stored: { parentSessionKey: "stale-parent" },
      },
    };

    expect(resolveAudience("child", graph, (key) => key.toLowerCase())).toEqual([
      "child",
      "parent",
    ]);
  });

  it("falls back to one stored parent when registry lineage is unusable", () => {
    const graph: Record<string, GraphNode> = {
      child: {
        registry: { controllerSessionKey: " ", requesterSessionKey: null },
        stored: { parentSessionKey: "dashboard-parent", spawnedBy: "spawn-parent" },
      },
      "dashboard-parent": { stored: { spawnedBy: "root" } },
    };

    expect(resolveAudience("child", graph)).toEqual(["child", "dashboard-parent", "root"]);
  });

  it("scopes relative aliases while preserving explicit cross-agent parents", () => {
    const graph: Record<string, GraphNode> = {
      "agent:worker:child": {
        registry: {
          controllerSessionKey: "main",
          requesterSessionKey: "agent:ops:main",
        },
      },
    };
    const canonicalize = (key: string, relativeTo?: string) => {
      if (key.startsWith("agent:")) {
        return key;
      }
      const relativeAgent = relativeTo?.split(":")[1] ?? "worker";
      return `agent:${relativeAgent}:${key}`;
    };

    expect(resolveAudience("agent:worker:child", graph, canonicalize)).toEqual([
      "agent:worker:child",
      "agent:worker:main",
      "agent:ops:main",
    ]);
  });

  it("guards cycles and includes each session once", () => {
    const graph: Record<string, GraphNode> = {
      child: {
        registry: { controllerSessionKey: "parent", requesterSessionKey: "child" },
      },
      parent: { stored: { parentSessionKey: "child" } },
    };

    expect(resolveAudience("child", graph)).toEqual(["child", "parent"]);
  });

  it("caps a malformed lineage graph at 64 sessions", () => {
    const graph = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `session-${index}`,
        { stored: { parentSessionKey: `session-${index + 1}` } },
      ]),
    );

    const audience = resolveAudience("session-0", graph);

    expect(audience).toHaveLength(64);
    expect(audience[0]).toBe("session-0");
    expect(audience.at(-1)).toBe("session-63");
  });
});

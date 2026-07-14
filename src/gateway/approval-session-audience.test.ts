import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveApprovalSessionAudienceWithFallback,
  resolveApprovalSourceStreamKey,
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

let graph: Record<string, GraphNode> = {};
const getRuntimeConfigMock = vi.fn(() => ({}) as object);
const getLatestSubagentRunMock = vi.fn((sessionKey: string) => graph[sessionKey]?.registry);
const loadSessionEntryMock = vi.fn(
  (scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored,
);
const buildLatestSubagentRunReadIndexMock = vi.fn(() => ({
  getLatestSubagentRun: getLatestSubagentRunMock,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));
vi.mock("../agents/subagent-registry-read.js", () => ({
  buildLatestSubagentRunReadIndex: () => buildLatestSubagentRunReadIndexMock(),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (scope: { sessionKey: string }) => loadSessionEntryMock(scope),
}));

beforeEach(() => {
  graph = {};
  getRuntimeConfigMock.mockReset().mockReturnValue({});
  getLatestSubagentRunMock
    .mockReset()
    .mockImplementation((sessionKey: string) => graph[sessionKey]?.registry);
  loadSessionEntryMock
    .mockReset()
    .mockImplementation((scope: { sessionKey: string }) => graph[scope.sessionKey]?.stored);
  buildLatestSubagentRunReadIndexMock.mockReset().mockReturnValue({
    getLatestSubagentRun: getLatestSubagentRunMock,
  });
});

describe("resolveApprovalSessionAudienceWithFallback", () => {
  it("keeps the canonical source first when it has no ancestors", () => {
    expect(resolveApprovalSessionAudienceWithFallback(" Child ", "work")).toEqual([
      "agent:work:child",
    ]);
  });

  it("walks registry controller and requester branches breadth-first", () => {
    graph = {
      "agent:work:child": {
        registry: {
          controllerSessionKey: "controller",
          requesterSessionKey: "requester",
        },
        stored: { parentSessionKey: "stale-parent" },
      },
      "agent:work:controller": { stored: { parentSessionKey: "controller-root" } },
      "agent:work:requester": { stored: { parentSessionKey: "requester-root" } },
    };

    expect(resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:controller",
      "agent:work:requester",
      "agent:work:controller-root",
      "agent:work:requester-root",
    ]);
  });

  it("falls back to stored lineage when registry lineage is unusable", () => {
    graph = {
      "agent:work:child": {
        registry: { controllerSessionKey: " ", requesterSessionKey: null },
        stored: { parentSessionKey: "dashboard-parent", spawnedBy: "spawn-parent" },
      },
      "agent:work:dashboard-parent": { stored: { spawnedBy: "root" } },
    };

    expect(resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:dashboard-parent",
      "agent:work:root",
    ]);
  });

  it("scopes relative aliases while preserving explicit cross-agent parents", () => {
    graph = {
      "agent:work:child": {
        registry: {
          controllerSessionKey: "main",
          requesterSessionKey: "agent:ops:main",
        },
      },
    };

    expect(resolveApprovalSessionAudienceWithFallback("agent:work:child", "work")).toEqual([
      "agent:work:child",
      "agent:work:main",
      "agent:ops:main",
    ]);
  });

  it("guards cycles and includes each session once", () => {
    graph = {
      "agent:work:child": {
        registry: { controllerSessionKey: "parent", requesterSessionKey: "child" },
      },
      "agent:work:parent": { stored: { parentSessionKey: "child" } },
    };

    expect(resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
      "agent:work:parent",
    ]);
  });

  it("caps a malformed lineage graph at 64 sessions", () => {
    graph = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `agent:work:session-${index}`,
        { stored: { parentSessionKey: `session-${index + 1}` } },
      ]),
    );

    const audience = resolveApprovalSessionAudienceWithFallback("session-0", "work");

    expect(audience).toHaveLength(64);
    expect(audience[0]).toBe("agent:work:session-0");
    expect(audience.at(-1)).toBe("agent:work:session-63");
  });

  it("canonicalizes configured main-key aliases when lineage lookup throws", () => {
    getRuntimeConfigMock.mockReturnValue({ session: { mainKey: "boss" } });
    buildLatestSubagentRunReadIndexMock.mockImplementationOnce(() => {
      throw new Error("registry unavailable");
    });

    expect(resolveApprovalSessionAudienceWithFallback("main", "work")).toEqual(["agent:work:boss"]);
  });

  it("scopes unscoped aliases even when config loading throws", () => {
    getRuntimeConfigMock.mockImplementation(() => {
      throw new Error("config unavailable");
    });

    expect(resolveApprovalSessionAudienceWithFallback("child", "work")).toEqual([
      "agent:work:child",
    ]);
  });
});

describe("resolveApprovalSourceStreamKey fallback scoping", () => {
  it("scopes raw fallback aliases to the raising agent", () => {
    expect(resolveApprovalSourceStreamKey("child", "work")).toBe("agent:work:child");
    expect(resolveApprovalSourceStreamKey("GLOBAL", "work")).toBe("agent:work:global");
  });

  it("keeps agent-scoped, unknown, and agent-less keys exact", () => {
    expect(resolveApprovalSourceStreamKey("agent:other:child", "work")).toBe("agent:other:child");
    expect(resolveApprovalSourceStreamKey("unknown", "work")).toBe("unknown");
    expect(resolveApprovalSourceStreamKey("child", null)).toBe("child");
  });
});

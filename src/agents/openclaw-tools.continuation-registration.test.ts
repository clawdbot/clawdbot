import { describe, expect, it, vi } from "vitest";

// Mock loadConfig + resolveGatewayPort the same way other openclaw-tools.* tests do,
// so calls inside createOpenClawTools that read shared config don't reach the real
// disk-backed loader.
const mockConfig: Record<string, unknown> = {
  session: { mainKey: "main", scope: "per-sender" },
};
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});

// Skip plugin tool resolution (we pass `disablePluginTools: true`), but the
// import graph still loads it; stub the heavy bits.
vi.mock("../plugins/tools.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/tools.js")>("../plugins/tools.js");
  return {
    ...actual,
    getPluginToolMeta: () => undefined,
  };
});

import { createOpenClawTools } from "./openclaw-tools.js";

const CONTINUATION_TOOLS = ["continue_work", "continue_delegate", "request_compaction"] as const;

function buildRequestCompactionOpts() {
  return {
    sessionId: "test-session-x5.1",
    getContextUsage: () => 0.85,
    triggerCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
  };
}

function buildContinueWorkOpts() {
  return {
    requestContinuation: vi.fn(),
  };
}

function continuationToolNames(tools: Array<{ name: string }>): string[] {
  return tools
    .map((t) => t.name)
    .filter((name): name is (typeof CONTINUATION_TOOLS)[number] =>
      (CONTINUATION_TOOLS as readonly string[]).includes(name),
    );
}

describe("createOpenClawTools — continuation-tool registration visibility", () => {
  it("registers no continuation tools when continuation.enabled is unset", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: { session: { mainKey: "main", scope: "per-sender" } } as never,
    });
    expect(continuationToolNames(tools)).toEqual([]);
  }, 240_000); // (~360ms each). // timeout shared across unrelated PRs. Tests 2–7 reuse the warm cache // CI noise pushes it past vitest's 120s default and produces a flaky // pi-embedded-*, plugins/tools, config/config). Quiet-box cost ≈ 95s; // createOpenClawTools + transitive imports (compaction-attribution, // First test in this file pays the cold module-load cost for

  it("registers no continuation tools when continuation.enabled is explicitly false", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: false } } },
      } as never,
    });
    expect(continuationToolNames(tools)).toEqual([]);
  });

  it("registers no continuation tools when the caller disables their lifecycle", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      disableContinuationTools: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      continueWorkOpts: buildContinueWorkOpts(),
      requestCompactionOpts: buildRequestCompactionOpts(),
    });
    expect(continuationToolNames(tools)).toEqual([]);
  });

  it("does not register request_compaction when continuation.enabled is true but requestCompactionOpts is missing", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      continueWorkOpts: buildContinueWorkOpts(),
    });
    const names = continuationToolNames(tools);
    expect(names).toContain("continue_work");
    expect(names).toContain("continue_delegate");
    expect(names).not.toContain("request_compaction");
  });

  it("registers request_compaction when continuation.enabled is true AND requestCompactionOpts is provided", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      continueWorkOpts: buildContinueWorkOpts(),
      requestCompactionOpts: buildRequestCompactionOpts(),
    });
    const names = continuationToolNames(tools);
    expect(names).toContain("continue_work");
    expect(names).toContain("continue_delegate");
    expect(names).toContain("request_compaction");
  });

  it("does not register request_compaction even with opts when continuation.enabled is unset", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: { session: { mainKey: "main", scope: "per-sender" } } as never,
      requestCompactionOpts: buildRequestCompactionOpts(),
    });
    expect(continuationToolNames(tools)).toEqual([]);
  });

  it("registers request_compaction with the expected tool surface (name + parameters present)", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      requestCompactionOpts: buildRequestCompactionOpts(),
    });
    const requestCompaction = tools.find((t) => t.name === "request_compaction");
    expect(requestCompaction).toBeDefined();
    expect(requestCompaction?.parameters).toBeDefined();
    expect(typeof requestCompaction?.execute).toBe("function");
  });

  it("registers continuation tools at most once per createOpenClawTools call", () => {
    const tools = createOpenClawTools({
      agentSessionKey: "main",
      disablePluginTools: true,
      disableMessageTool: true,
      config: {
        session: { mainKey: "main", scope: "per-sender" },
        agents: { defaults: { continuation: { enabled: true } } },
      } as never,
      requestCompactionOpts: buildRequestCompactionOpts(),
    });
    const names = continuationToolNames(tools);
    const counts = new Map<string, number>();
    for (const name of names) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) {
      expect(count, `tool ${name} should appear exactly once`).toBe(1);
    }
  });
});

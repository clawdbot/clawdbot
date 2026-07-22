import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { McpLoopbackToolCache, resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";

const resolveGatewayScopedTools = vi.hoisted(() => vi.fn());

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools,
}));

function scopedToolFixture(names: string[]) {
  return {
    agentId: "main",
    tools: names.map((name) => ({ name, description: `${name} tool` })),
  };
}

function scopeParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {} as OpenClawConfig,
    sessionKey: "agent:main:recall",
    messageProvider: undefined,
    currentChannelId: undefined,
    currentThreadTs: undefined,
    currentMessageId: undefined,
    currentInboundAudio: undefined,
    accountId: undefined,
    inboundEventKind: undefined,
    sourceReplyDeliveryMode: undefined,
    senderIsOwner: undefined,
    ...overrides,
  } as Parameters<typeof resolveMcpLoopbackScopedTools>[0];
}

beforeEach(() => {
  resolveGatewayScopedTools.mockReset();
  resolveGatewayScopedTools.mockReturnValue(
    scopedToolFixture(["memory_search", "memory_get", "message", "cron"]),
  );
});

describe("resolveMcpLoopbackScopedTools", () => {
  it("keeps the full session scope without a grant allowlist", () => {
    const scoped = resolveMcpLoopbackScopedTools(scopeParams());
    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "memory_search",
      "memory_get",
      "message",
      "cron",
    ]);
  });

  it("hard-filters the surface to the grant allowlist", () => {
    const scoped = resolveMcpLoopbackScopedTools(
      scopeParams({ toolsAllow: ["memory_search", "memory_get"] }),
    );
    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "memory_search",
      "memory_get",
    ]);
  });

  it("fails closed on an empty grant allowlist", () => {
    const scoped = resolveMcpLoopbackScopedTools(scopeParams({ toolsAllow: [] }));
    expect(scoped.tools).toEqual([]);
  });

  it("excludes self-scheduling continuation controls but keeps continue_delegate", () => {
    resolveGatewayScopedTools.mockImplementation((params: { excludeToolNames?: Set<string> }) => {
      const names = ["continue_work", "request_compaction", "continue_delegate", "message"];
      return scopedToolFixture(names.filter((name) => !params.excludeToolNames?.has(name)));
    });

    const scoped = resolveMcpLoopbackScopedTools(scopeParams());

    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "continue_delegate",
      "message",
    ]);
  });

  it("exposes explicitly granted coding tools through the mediated loopback surface", () => {
    resolveGatewayScopedTools.mockReturnValue(scopedToolFixture(["read", "exec", "browser"]));

    const scoped = resolveMcpLoopbackScopedTools(
      scopeParams({
        toolsAllow: ["read", "exec", "browser"],
        nodeExecAllowed: true,
      }),
    );

    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "read",
      "exec",
      "browser",
    ]);
    const call = resolveGatewayScopedTools.mock.calls[0]?.[0] as {
      excludeToolNames?: Set<string>;
      includeNodeExecTool?: boolean;
    };
    expect(call.includeNodeExecTool).toBe(false);
    expect(call.excludeToolNames?.has("read")).toBe(false);
    expect(call.excludeToolNames?.has("exec")).toBe(false);
    expect(call.excludeToolNames?.has("write")).toBe(true);
  });
});

describe("McpLoopbackToolCache", () => {
  it("does not share cache rows across different grant allowlists", () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    const unrestricted = cache.resolve(scopeParams({ cfg }));
    const restricted = cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    const denied = cache.resolve(scopeParams({ cfg, toolsAllow: [] }));

    expect(unrestricted.tools).toHaveLength(4);
    expect(restricted.tools).toHaveLength(1);
    expect(denied.tools).toHaveLength(0);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);

    // Same allowlist reuses the cached row.
    cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });
});

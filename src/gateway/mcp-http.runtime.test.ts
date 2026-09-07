import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";

const resolveGatewayScopedTools = vi.hoisted(() => vi.fn());
const listNodes = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool: async (
    _method: string,
    _opts: unknown,
    _args: unknown,
    options: { signal?: AbortSignal },
  ) => ({ nodes: await listNodes(options.signal) }),
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools,
}));

function scopedToolFixture(names: string[]) {
  return {
    agentId: "main",
    tools: names.map((name) => ({ name, description: `${name} tool` })),
  };
}

type ScopeParams = Parameters<typeof resolveMcpLoopbackScopedTools>[0];

function scopeParams({
  cfg = {} as OpenClawConfig,
  grantToken,
  ...context
}: Partial<ScopeParams["context"] & Pick<ScopeParams, "cfg" | "grantToken">> = {}): ScopeParams {
  return {
    cfg,
    grantToken,
    context: { sessionKey: "agent:main:recall", senderIsOwner: false, ...context },
  };
}

beforeEach(() => {
  listNodes.mockReset();
  listNodes.mockResolvedValue([]);
  resolveGatewayScopedTools.mockReset();
  resolveGatewayScopedTools.mockReturnValue(
    scopedToolFixture(["memory_search", "memory_get", "message", "cron"]),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("node execution discovery", () => {
  it("treats an unavailable Gateway as unavailable node execution", async () => {
    listNodes.mockRejectedValueOnce(new Error("synthetic transport failure"));
    const availability = await loadNodeExecAvailability();
    expect(availability.isAvailable()).toBe(false);
  });

  it("preserves the abort reason when discovery also reports a transport failure", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic attempt cancelled");
    listNodes.mockImplementationOnce((signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      throw new Error("synthetic transport failure");
    });
    await expect(loadNodeExecAvailability(controller.signal)).rejects.toBe(reason);
  });
});

describe("resolveMcpLoopbackScopedTools", () => {
  it.each([
    { name: "no nodes", nodes: [], exposed: false },
    {
      name: "offline executor",
      nodes: [{ nodeId: "worker", connected: false, commands: ["system.run"] }],
      exposed: false,
    },
    {
      name: "approval-only phone",
      nodes: [{ nodeId: "phone", connected: true, commands: ["canvas.present"] }],
      exposed: false,
    },
    {
      name: "unknown capabilities",
      nodes: [{ nodeId: "phone", connected: true }],
      exposed: false,
    },
    {
      name: "eligible named binding",
      node: "Build Worker",
      nodes: [
        {
          nodeId: "worker",
          displayName: "Build Worker",
          connected: true,
          commands: ["system.run"],
        },
      ],
      exposed: true,
    },
    {
      name: "ambiguous binding",
      node: "Build Worker",
      nodes: [
        { nodeId: "phone", displayName: "Build Worker", connected: true, commands: [] },
        {
          nodeId: "worker",
          displayName: "Build Worker",
          connected: true,
          commands: ["system.run"],
        },
      ],
      exposed: false,
    },
    {
      name: "eligible executor",
      nodes: [{ nodeId: "worker", connected: true, commands: ["system.run"] }],
      exposed: true,
    },
    {
      name: "multiple executors",
      nodes: ["one", "two"].map((nodeId) => ({
        nodeId,
        connected: true,
        commands: ["system.run"],
      })),
      exposed: true,
    },
    {
      name: "offline binding beside executor",
      node: "phone",
      nodes: [
        { nodeId: "phone", connected: false, commands: [] },
        { nodeId: "worker", connected: true, commands: ["system.run"] },
      ],
      exposed: false,
    },
  ])(
    "advertises remote exec only with an eligible target: $name",
    async ({ nodes, node, exposed }) => {
      listNodes.mockResolvedValue(nodes);
      resolveGatewayScopedTools.mockImplementation(
        ({ includeNodeExecTool, nodeExecAvailable, execOverrides }) =>
          scopedToolFixture(
            includeNodeExecTool && nodeExecAvailable?.(execOverrides?.node) ? ["exec"] : [],
          ),
      );
      const scoped = await resolveMcpLoopbackScopedTools(
        scopeParams({
          senderIsOwner: true,
          nodeExecAllowed: true,
          execOverrides: { mode: "full", node },
        }),
      );
      expect(scoped.tools.map((tool) => tool.name)).toEqual(exposed ? ["exec"] : []);
    },
  );

  it("keeps the full session scope without a grant allowlist", async () => {
    const scoped = await resolveMcpLoopbackScopedTools(scopeParams());
    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "memory_search",
      "memory_get",
      "message",
      "cron",
    ]);
  });

  it("hard-filters the surface to the grant allowlist", async () => {
    const scoped = await resolveMcpLoopbackScopedTools(
      scopeParams({ toolsAllow: ["memory_search", "memory_get"] }),
    );
    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "memory_search",
      "memory_get",
    ]);
  });

  it("keeps exact grant names exact instead of reinterpreting policy shorthand", async () => {
    resolveGatewayScopedTools.mockReturnValue(scopedToolFixture(["write", "apply_patch"]));

    const scoped = await resolveMcpLoopbackScopedTools(scopeParams({ toolsAllow: ["write"] }));

    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual(["write"]);
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).toMatchObject({
      mediatedToolNames: new Set(["write"]),
    });
  });

  it("fails closed on an empty grant allowlist", async () => {
    const scoped = await resolveMcpLoopbackScopedTools(scopeParams({ toolsAllow: [] }));
    expect(scoped.tools).toEqual([]);
  });

  it("forwards the exact Skill Workshop revision into loopback tool construction", async () => {
    const proposalRevision = {
      agentId: "proposal-owner",
      workspaceDir: "/proposal-workspace",
      proposalId: "proposal-h1",
      expectedRevisionHash: "1".repeat(64),
    };

    await resolveMcpLoopbackScopedTools(
      scopeParams({
        toolsAllow: ["skill_workshop"],
        skillWorkshop: { proposalRevision },
      }),
    );

    expect(resolveGatewayScopedTools).toHaveBeenCalledWith(
      expect.objectContaining({ skillWorkshop: { proposalRevision } }),
    );
  });

  it("exposes explicitly granted coding tools through the mediated loopback surface", async () => {
    resolveGatewayScopedTools.mockReturnValue(scopedToolFixture(["read", "exec", "browser"]));

    const scoped = await resolveMcpLoopbackScopedTools(
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
      mediatedToolNames?: Set<string>;
      includeNodeExecTool?: boolean;
    };
    expect(call.includeNodeExecTool).toBe(false);
    expect(call.excludeToolNames?.has("read")).toBe(false);
    expect(call.excludeToolNames?.has("exec")).toBe(false);
    expect(call.excludeToolNames?.has("write")).toBe(true);
    expect(call.mediatedToolNames).toEqual(new Set(["read", "exec"]));
  });

  it.each([
    { allow: ["write"], expected: ["write", "apply_patch"] },
    { allow: ["apply-patch"], expected: ["apply_patch"] },
    { allow: ["web_*"], expected: ["web_search", "web_fetch"] },
    { allow: ["group:fs"], expected: ["read", "write", "edit", "apply_patch"] },
    { allow: [] as string[], expected: [] },
    { allow: ["unknown"], expected: [] },
  ])(
    "materializes policy expressions into concrete loopback tools: $allow",
    async ({ allow, expected }) => {
      resolveGatewayScopedTools.mockReturnValue(
        scopedToolFixture([
          "read",
          "write",
          "edit",
          "apply_patch",
          "web_search",
          "web_fetch",
          "message",
        ]),
      );

      const scoped = await resolveMcpLoopbackPolicyTools(scopeParams({ toolsAllow: allow }));

      expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual(expected);
    },
  );

  it.each([
    { allow: ["group:plugins"], expected: ["memory_search", "memory_get"] },
    { allow: ["active-memory"], expected: ["memory_search", "memory_get"] },
  ])("materializes plugin policy selectors: $allow", async ({ allow, expected }) => {
    const pluginTools = ["memory_search", "memory_get"].map((name) => ({
      name,
      description: `${name} tool`,
    }));
    for (const tool of pluginTools) {
      setPluginToolMeta(tool as never, { pluginId: "active-memory", optional: false });
    }
    resolveGatewayScopedTools.mockReturnValue({
      agentId: "main",
      tools: [...pluginTools, { name: "message", description: "message tool" }],
    });

    const scoped = await resolveMcpLoopbackPolicyTools(scopeParams({ toolsAllow: allow }));

    expect(scoped.tools.map((tool) => (tool as { name: string }).name)).toEqual(expected);
  });
});

describe("McpLoopbackToolCache", () => {
  it("rechecks execution availability before reusing cached schemas", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ senderIsOwner: true, nodeExecAllowed: true });
    resolveGatewayScopedTools.mockImplementation(({ includeNodeExecTool, nodeExecAvailable }) =>
      scopedToolFixture(includeNodeExecTool && nodeExecAvailable?.() ? ["exec"] : []),
    );
    for (const connected of [false, true, false]) {
      listNodes.mockResolvedValue([{ nodeId: "worker", connected, commands: ["system.run"] }]);
      const result = await cache.resolve(params);
      expect(result.tools.map((tool) => tool.name)).toEqual(connected ? ["exec"] : []);
    }
  });

  it.each(["evict", "clear"])(
    "does not resurrect cache rows when %s overtakes discovery",
    async (action) => {
      const cache = new McpLoopbackToolCache();
      const params = scopeParams({ nodeExecAllowed: true, grantToken: "pending-grant" });
      const entered = createDeferred();
      const inventory = createDeferred<unknown[]>();
      listNodes.mockImplementationOnce(() => {
        entered.resolve();
        return inventory.promise;
      });
      const pending = cache.resolve(params);
      await entered.promise;
      if (action === "evict") {
        cache.evictGrant("pending-grant");
      } else {
        cache.clear();
      }
      inventory.resolve([]);
      await pending;
      expect(cache.evictGrant("pending-grant")).toBe(false);
      await cache.resolve(params);
      expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    },
  );

  it("does not cache tools when cancellation overtakes discovery", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ nodeExecAllowed: true, grantToken: "cancelled-grant" });
    const controller = new AbortController();
    const reason = new Error("synthetic request cancelled");
    const entered = createDeferred();
    const inventory = createDeferred<unknown[]>();
    listNodes.mockImplementationOnce(() => {
      entered.resolve();
      return inventory.promise;
    });
    const rejected = expect(cache.resolve({ ...params, signal: controller.signal })).rejects.toBe(
      reason,
    );
    await entered.promise;
    expect(listNodes).toHaveBeenCalledWith(controller.signal);
    controller.abort(reason);
    inventory.resolve([]);
    await rejected;
    expect(cache.evictGrant("cancelled-grant")).toBe(false);
    const next = new AbortController();
    await cache.resolve({ ...params, signal: next.signal });
    next.abort();
    await cache.resolve({ ...params, signal: new AbortController().signal });
    expect(resolveGatewayScopedTools).toHaveBeenCalledOnce();
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).not.toHaveProperty("signal");
  });

  it("refreshes cached bound tools when node matching preferences change", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ nodeExecAllowed: true, execOverrides: { node: "shared-name" } });
    resolveGatewayScopedTools.mockImplementation(({ nodeExecAvailable, execOverrides }) =>
      scopedToolFixture(nodeExecAvailable(execOverrides.node) ? ["exec"] : []),
    );
    for (const eligibleIsCurrent of [false, true, false]) {
      listNodes.mockResolvedValue([
        {
          nodeId: "phone",
          displayName: "shared-name",
          connected: true,
          commands: [],
          clientId: eligibleIsCurrent ? "clawdbot-node" : "openclaw-node",
        },
        {
          nodeId: "worker",
          displayName: "shared-name",
          connected: true,
          commands: ["system.run"],
          clientId: eligibleIsCurrent ? "openclaw-node" : "clawdbot-node",
        },
      ]);
      const scoped = await cache.resolve(params);
      expect(scoped.tools.map((tool) => tool.name)).toEqual(eligibleIsCurrent ? ["exec"] : []);
    }
  });

  it("expires at the ttl boundary and partitions rows by config identity", async () => {
    vi.useFakeTimers();
    const cache = new McpLoopbackToolCache();
    const cfgA = {} as OpenClawConfig;
    const cfgB = {} as OpenClawConfig;
    const paramsA = scopeParams({ cfg: cfgA });

    await cache.resolve(paramsA);
    await cache.resolve(paramsA);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await cache.resolve(paramsA);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);

    await cache.resolve(scopeParams({ cfg: cfgB }));
    await cache.resolve(paramsA);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });

  it("does not share cache rows across different grant allowlists", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    const unrestricted = await cache.resolve(scopeParams({ cfg }));
    const restricted = await cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search"] }));
    const denied = await cache.resolve(scopeParams({ cfg, toolsAllow: [] }));

    expect(unrestricted.tools).toHaveLength(4);
    expect(restricted.tools).toHaveLength(1);
    expect(denied.tools).toHaveLength(0);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);

    // Duplicate entries do not change the granted set.
    await cache.resolve(scopeParams({ cfg, toolsAllow: ["memory_search", "memory_search"] }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });

  it("does not share cache rows across different runtime policy agents", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    await cache.resolve(scopeParams({ cfg, runtimePolicyAgentId: "main" }));
    await cache.resolve(scopeParams({ cfg, runtimePolicyAgentId: "worker" }));
    await cache.resolve(scopeParams({ cfg, runtimePolicyAgentId: "main" }));

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });

  it("does not share loopback tools across prepared vision capabilities", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    await cache.resolve(scopeParams({ cfg, modelHasVision: true }));
    await cache.resolve(scopeParams({ cfg, modelHasVision: false }));
    await cache.resolve(scopeParams({ cfg, modelHasVision: true }));

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).toMatchObject({
      modelHasVision: true,
    });
    expect(resolveGatewayScopedTools.mock.calls[1]?.[0]).toMatchObject({
      modelHasVision: false,
    });
  });

  it("does not share loopback message tools across prepared reply modes", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    await cache.resolve(scopeParams({ cfg, replyToMode: "all" }));
    await cache.resolve(scopeParams({ cfg, replyToMode: "off" }));
    await cache.resolve(scopeParams({ cfg, replyToMode: "all" }));

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).toMatchObject({ replyToMode: "all" });
    expect(resolveGatewayScopedTools.mock.calls[1]?.[0]).toMatchObject({ replyToMode: "off" });
  });

  it("keeps pinned widget authoring out of capless cached tool lists", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams();
    resolveGatewayScopedTools.mockImplementation(({ pinnedWidgetAuthoring }) =>
      scopedToolFixture(pinnedWidgetAuthoring ? ["dashboard", "show_widget"] : ["dashboard"]),
    );

    for (const pinnedWidgetAuthoring of [true, undefined, true, false]) {
      const result = await cache.resolve({
        ...params,
        context: { ...params.context, pinnedWidgetAuthoring },
      });
      expect(result.tools.map((tool) => tool.name)).toEqual(
        pinnedWidgetAuthoring ? ["dashboard", "show_widget"] : ["dashboard"],
      );
    }
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });

  it("evicts only the revoked grant's cached tool closures", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);

    expect(cache.evictGrant("grant-a")).toBe(true);
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a" }));
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b" }));

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(3);
  });

  it("preserves the global 256-entry cache cap across grants", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    for (let index = 0; index < 256; index += 1) {
      await cache.resolve(
        scopeParams({ cfg, grantToken: "grant-a", currentMessageId: `message-${index}` }),
      );
    }
    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b", currentMessageId: "message-b" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(257);

    await cache.resolve(scopeParams({ cfg, grantToken: "grant-a", currentMessageId: "message-0" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(258);

    await cache.resolve(scopeParams({ cfg, grantToken: "grant-b", currentMessageId: "message-b" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(258);
  });

  it("never reuses ordinary private-mode tools for a source-reply-only grant", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;
    const params = scopeParams({
      cfg,
      messageProvider: "telegram",
      currentChannelId: "telegram:chat123",
      sourceReplyDeliveryMode: "message_tool_only",
      toolsAllow: ["message"],
    });

    await cache.resolve(params);
    await cache.resolve({ ...params, context: { ...params.context, sourceReplyOnly: true } });
    await cache.resolve(params);
    await cache.resolve({ ...params, context: { ...params.context, sourceReplyOnly: true } });

    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).not.toHaveProperty("sourceReplyOnly");
    expect(resolveGatewayScopedTools.mock.calls[1]?.[0]).toMatchObject({ sourceReplyOnly: true });
  });

  it("does not share cache rows across delegation capabilities", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;

    await cache.resolve(scopeParams({ cfg }));
    await cache.resolve(scopeParams({ cfg, delegationCapability: "report_only" }));

    // A restricted attempt must neither read nor seed the full-capability row
    // for the same session context.
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    expect(resolveGatewayScopedTools.mock.calls[1]?.[0]).toMatchObject({
      delegationCapability: "report_only",
    });

    await cache.resolve(scopeParams({ cfg, delegationCapability: "report_only" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrantsForRuntime,
} from "./mcp-grant-store.js";
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

function nodeExecToolFixture(
  params: Parameters<typeof import("./tool-resolution.js").resolveGatewayScopedTools>[0],
) {
  const project = (available = params.nodeExecAvailable) =>
    scopedToolFixture(
      params.includeNodeExecTool && available?.(params.execOverrides?.node) ? ["exec"] : [],
    ).tools;
  return { agentId: "main", tools: project(), refreshNodeExecTools: project };
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
    senderIsOwner: false,
    ...overrides,
  } as Parameters<typeof resolveMcpLoopbackScopedTools>[0];
}

beforeEach(() => {
  listNodes.mockReset();
  listNodes.mockResolvedValue([]);
  resolveGatewayScopedTools.mockReset();
  resolveGatewayScopedTools.mockReturnValue(
    scopedToolFixture(["memory_search", "memory_get", "message", "cron"]),
  );
});

const admissions: PreparedAgentRunAdmission[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  await revokeMcpLoopbackClientGrantsForRuntime("cache-test");
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

async function clientCapture(params: ReturnType<typeof scopeParams>) {
  const runId = `cache-${admissions.length}`;
  const admission = prepareAgentRunAdmission({
    cfg: params.cfg,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-cache-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const { cfg: _cfg, ...context } = params;
  const grant = mintMcpLoopbackClientGrant({
    context: { ...context, senderIsOwner: params.senderIsOwner ?? false },
    runtimeOwnerToken: "cache-test",
    admittedRunContext: await admission.admit("gateway", runId),
  });
  const capture = activateMcpLoopbackClientGrantCapture({
    token: grant.token,
    expectedOwner: grant,
    runtimeOwnerToken: "cache-test",
    captureKey: "reused-key",
  })!;
  await capture.ready;
  return capture;
}

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
    resolveGatewayScopedTools.mockImplementation(nodeExecToolFixture);
    const capture = await clientCapture(params);
    for (const connected of [false, true, false]) {
      listNodes.mockResolvedValue([{ nodeId: "worker", connected, commands: ["system.run"] }]);
      const result = await cache.resolve(params, capture);
      expect(result.tools.map((tool) => tool.name)).toEqual(connected ? ["exec"] : []);
    }
  });

  it.each(["capture-close", "runtime-close"] as const)(
    "does not resurrect executable bundles when %s overtakes discovery",
    async (action) => {
      const cache = new McpLoopbackToolCache();
      const params = scopeParams({ nodeExecAllowed: true });
      const capture = await clientCapture(params);
      const entered = createDeferred();
      const inventory = createDeferred<unknown[]>();
      listNodes.mockImplementationOnce(() => {
        entered.resolve();
        return inventory.promise;
      });
      const pending = cache.resolve(params, capture);
      await entered.promise;
      if (action === "capture-close") {
        await capture.close("completion");
      } else {
        await revokeMcpLoopbackClientGrantsForRuntime("cache-test");
        cache.clear();
      }
      const rejected = expect(pending).rejects.toBe(capture.signal.reason);
      inventory.resolve([]);
      await rejected;
      expect(resolveGatewayScopedTools).not.toHaveBeenCalled();
      await expect(cache.resolve(params, capture)).rejects.toBe(capture.signal.reason);
      await cache.resolve(params, await clientCapture(params));
      expect(resolveGatewayScopedTools).toHaveBeenCalledOnce();
    },
  );

  it("does not resurrect attachment metadata when clear overtakes resolution", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams();
    const pending = cache.resolve(params);
    cache.clear();
    await pending;
    await cache.resolve(params);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });

  it("does not cache canceled discovery or poison the next request", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ nodeExecAllowed: true });
    const capture = await clientCapture(params);
    const controller = new AbortController();
    const reason = new Error("synthetic request canceled");
    const entered = createDeferred<AbortSignal>();
    const inventory = createDeferred<unknown[]>();
    listNodes.mockImplementationOnce((signal: AbortSignal) => {
      entered.resolve(signal);
      return inventory.promise;
    });
    const rejected = expect(
      cache.resolve({ ...params, signal: controller.signal }, capture),
    ).rejects.toBe(reason);
    const discoverySignal = await entered.promise;
    controller.abort(reason);
    expect(discoverySignal.aborted).toBe(true);
    expect(discoverySignal.reason).toBe(reason);
    inventory.resolve([]);
    await rejected;
    expect(resolveGatewayScopedTools).not.toHaveBeenCalled();
    const next = new AbortController();
    const bundle = await cache.resolve({ ...params, signal: next.signal }, capture);
    next.abort();
    expect(await cache.resolve({ ...params, signal: new AbortController().signal }, capture)).toBe(
      bundle,
    );
    expect(resolveGatewayScopedTools).toHaveBeenCalledOnce();
    expect(resolveGatewayScopedTools.mock.calls[0]?.[0]).not.toHaveProperty("signal");
  });

  it("keeps another capture's bundle when retirement overtakes its discovery", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ nodeExecAllowed: true });
    const first = await clientCapture(params);
    await cache.resolve(params, first);
    const next = await clientCapture(params);
    const entered = createDeferred();
    const inventory = createDeferred<unknown[]>();
    listNodes.mockImplementationOnce(() => {
      entered.resolve();
      return inventory.promise;
    });
    const pending = cache.resolve(params, next);
    await entered.promise;
    await first.close("completion");
    inventory.resolve([]);
    const bundle = await pending;
    cache.clear();
    expect(await cache.resolve(params, next)).toBe(bundle);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
  });

  it("refreshes cached bound tools when node matching preferences change", async () => {
    const cache = new McpLoopbackToolCache();
    const params = scopeParams({ nodeExecAllowed: true, execOverrides: { node: "shared-name" } });
    resolveGatewayScopedTools.mockImplementation(nodeExecToolFixture);
    const capture = await clientCapture(params);
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
      const scoped = await cache.resolve(params, capture);
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

  it.each([
    ["allowlist", { toolsAllow: ["memory_search"] }],
    ["empty allowlist", { toolsAllow: [] }],
    ["runtime policy agent", { runtimePolicyAgentId: "worker" }],
    ["vision", { modelHasVision: true }],
    ["reply mode", { replyToMode: "all" }],
    ["source-only reply", { sourceReplyOnly: true }],
    ["delegation", { delegationCapability: "report_only" }],
    ["client capabilities", { clientCaps: ["inline-widgets"] }],
    [
      "elevated permission",
      { bashElevated: { enabled: true, allowed: true, defaultLevel: "full" } },
    ],
    [
      "exec defaults",
      { execSession: { execHost: "node", execNode: "fixture-node" }, nodeExecAllowed: true },
    ],
    ["exec mode", { execOverrides: { mode: "full" } }],
    ["owner", { senderIsOwner: true }],
  ])("isolates and forwards %s through distinct real CLI captures", async (_name, fields) => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;
    const firstParams = scopeParams({ cfg });
    const nextParams = scopeParams({ cfg, ...fields });
    const first = await clientCapture(firstParams);
    const next = await clientCapture(nextParams);
    const firstTools = await cache.resolve(firstParams, first);
    const nextTools = await cache.resolve(nextParams, next);
    expect(nextTools).not.toBe(firstTools);
    expect(await cache.resolve(firstParams, first)).toBe(firstTools);
    expect(await cache.resolve(nextParams, next)).toBe(nextTools);
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(2);
    const { toolsAllow, nodeExecAllowed, ...forwarded } = fields as Partial<
      ReturnType<typeof scopeParams>
    >;
    expect(resolveGatewayScopedTools.mock.calls[1]?.[0]).toMatchObject(forwarded);
    if (toolsAllow) {
      expect(nextTools.tools.map((tool) => tool.name)).toEqual(toolsAllow);
    }
    if (nodeExecAllowed) {
      expect(resolveGatewayScopedTools.mock.calls[1]?.[0].includeNodeExecTool).toBe(true);
    }
    await first.close("completion");
    await expect(cache.resolve(firstParams, first)).rejects.toBe(first.signal.reason);
    expect(await cache.resolve(nextParams, next)).toBe(nextTools);
  });

  it("caps attachment metadata at 256 session-owner partitions", async () => {
    const cache = new McpLoopbackToolCache();
    const cfg = {} as OpenClawConfig;
    for (let index = 0; index < 257; index++) {
      await cache.resolve(scopeParams({ cfg, sessionKey: `agent:main:attachment-${index}` }));
    }
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(257);
    await cache.resolve(scopeParams({ cfg, sessionKey: "agent:main:attachment-0" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(258);
    await cache.resolve(scopeParams({ cfg, sessionKey: "agent:main:attachment-256" }));
    expect(resolveGatewayScopedTools).toHaveBeenCalledTimes(258);
  });
});

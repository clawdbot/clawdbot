import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "../../gateway/terminal/session-manager.test-helpers.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { consumeRepairableCodeModeFailure } from "../code-mode-repair-provenance.js";
import { createSubscribedCodeModeHarness } from "../code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { resultDetails } from "../code-mode.test-support.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createTerminalTool } from "./terminal-tool.js";

const getInProcessGatewayToolContext = vi.hoisted(() => vi.fn());
const loadGatewaySessionEntryReadOnly = vi.hoisted(() => vi.fn(() => ({ entry: undefined })));
const approvalMocks = vi.hoisted(() => ({
  register: vi.fn(async ({ approvalId }: { approvalId: string }) => ({
    id: approvalId,
    expiresAtMs: Date.now() + 10_000,
  })),
  decide: vi.fn(async (): Promise<string | null> => "allow-once"),
}));

vi.mock("./in-process-gateway.js", () => ({ getInProcessGatewayToolContext }));
vi.mock("../../gateway/session-utils-store.js", () => ({ loadGatewaySessionEntryReadOnly }));
vi.mock("../bash-tools.exec-approval-request.js", () => ({
  registerExecApprovalRequestForHostOrThrow: approvalMocks.register,
  resolveRegisteredExecApprovalDecision: approvalMocks.decide,
}));

const agentOwner = agentTerminalOwner("agent:main:main", "main-session-id");
type TerminalToolOptions = NonNullable<Parameters<typeof createTerminalTool>[0]>;

function makeContext(manager: TerminalSessionManager) {
  return { terminalSessions: manager };
}

function makeTool(manager: TerminalSessionManager, options: TerminalToolOptions = {}) {
  return createTerminalTool({
    agentId: "main",
    agentSessionKey: agentOwner.agentSessionKey,
    sessionId: agentOwner.agentSessionId,
    execSession: {},
    getGatewayContext: () => makeContext(manager),
    ...options,
  });
}

async function openAgentTerminal() {
  const backend = makeFakePty();
  const spawn = vi.fn(async () => backend);
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
  const opened = await manager.open(baseOpenRequest({ owner: agentOwner }));
  if (!opened.ok) {
    throw new Error("expected operator-opened terminal");
  }
  spawn.mockClear();
  return { backend, manager, sessionId: opened.sessionId, spawn };
}

async function withActiveRun<T>(
  manager: TerminalSessionManager,
  run: (authority: ReturnType<typeof claimAgentRunDelegatedAuthority>) => Promise<T>,
) {
  const operationalRunInstance = { instanceId: "terminal-instance", runId: "terminal-run" };
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  try {
    return await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: agentOwner.agentSessionKey,
        operationalRunInstance,
        gatewayContextResolver: () => makeContext(manager) as GatewayRequestContext,
      },
      () => run(authority),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("terminal tool", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    getInProcessGatewayToolContext.mockReset();
    loadGatewaySessionEntryReadOnly.mockClear();
    approvalMocks.register.mockClear();
    approvalMocks.decide.mockReset();
    approvalMocks.decide.mockResolvedValue("allow-once");
  });

  it("exposes existing-session controls but never shell creation behind the owner-only gate", () => {
    const tool = createTerminalTool();

    expect(tool.parameters).toMatchObject({
      properties: {
        action: { type: "string", enum: ["read", "list", "resize", "close", "input"] },
        sessionId: { type: "string" },
      },
    });
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "action",
      "sessionId",
      "data",
      "cols",
      "rows",
    ]);
    expect(schema.properties).not.toHaveProperty("command");
    expect(schema.properties).not.toHaveProperty("cwd");
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("terminal");
  });

  it("cannot open or spawn a gateway terminal even when an existing terminal is available", async () => {
    const { backend, manager, sessionId, spawn } = await openAgentTerminal();
    const tool = makeTool(manager);

    await expect(tool.execute("open", { action: "open", sessionId })).rejects.toThrow(
      "terminal action unavailable",
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(backend.writes).toEqual([]);
    expect(backend.resizes).toEqual([]);
    expect(backend.killed).toBe(false);
    expect(manager.size).toBe(1);
  });

  it("uses the admitted caller Gateway before ambient context", async () => {
    const callerManager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const ambientManager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const callerList = vi.spyOn(callerManager, "listAgent");
    const ambientList = vi.spyOn(ambientManager, "listAgent");
    const gatewayContextResolver = vi.fn();
    gatewayContextResolver.mockReturnValue(makeContext(callerManager));
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: agentOwner.agentSessionKey,
      sessionId: agentOwner.agentSessionId,
    });

    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: agentOwner.agentSessionKey,
        gatewayContextResolver,
      },
      async () => await tool.execute("list", { action: "list" }),
    );

    expect(result.details).toEqual({ sessions: [] });
    expect(callerList).toHaveBeenCalledOnce();
    expect(ambientList).not.toHaveBeenCalled();
  });

  it("fails closed when the admitted caller Gateway has retired", async () => {
    const ambientManager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const ambientList = vi.spyOn(ambientManager, "listAgent");
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: agentOwner.agentSessionKey,
      sessionId: agentOwner.agentSessionId,
    });

    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: agentOwner.agentSessionKey,
          gatewayContextResolver: () => undefined,
        },
        async () => await tool.execute("list", { action: "list" }),
      ),
    ).rejects.toThrow("terminal unavailable");
    expect(ambientList).not.toHaveBeenCalled();
  });

  it("uses ambient Gateway context without an admitted caller", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const list = vi.spyOn(manager, "listAgent");
    getInProcessGatewayToolContext.mockReturnValue(makeContext(manager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: agentOwner.agentSessionKey,
      sessionId: agentOwner.agentSessionId,
    });

    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("lists, reads, resizes, and closes only its existing operator-opened terminal", async () => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const opened = await manager.open(
      baseOpenRequest({ owner: agentOwner, viewerConnId: "operator" }),
    );
    if (!opened.ok) {
      throw new Error("expected operator-opened terminal");
    }
    const tool = makeTool(manager);

    expect(tool.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ sessions: Array<{ agentId: string; attached: boolean; createdAtMs: number; cwd: string; owner: string; sessionId: string; shell: string }> } | { sessionId: string; text: string } | { ok: true }",
    );

    const listed = await tool.execute("list", { action: "list" });
    expect(listed.details).toEqual({
      sessions: [
        expect.objectContaining({
          sessionId: opened.sessionId,
          attached: true,
          owner: `agent:${agentOwner.agentSessionKey}`,
        }),
      ],
    });
    expect(Value.Check(tool.outputSchema!, listed.details)).toBe(true);

    backend.emitData("\u001b[31mready\u001b[0m\r\n");
    const read = await tool.execute("read", { action: "read", sessionId: opened.sessionId });
    expect(read.details).toEqual({
      sessionId: opened.sessionId,
      text: expect.stringContaining("ready\n"),
    });
    expect((read.details as { text: string }).text).not.toContain("\u001b");
    expect(Value.Check(tool.outputSchema!, read.details)).toBe(true);

    expect(manager.write("operator", opened.sessionId, "operator command\r")).toBe(true);
    expect(backend.writes).toEqual(["operator command\r"]);

    const resized = await tool.execute("resize", {
      action: "resize",
      sessionId: opened.sessionId,
      cols: 120,
      rows: 40,
    });
    expect(resized.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, resized.details)).toBe(true);
    expect(backend.resizes).toEqual([[120, 40]]);

    const closed = await tool.execute("close", { action: "close", sessionId: opened.sessionId });
    expect(closed.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, closed.details)).toBe(true);
    expect(backend.killed).toBe(true);
  });

  it("cannot inspect, resize, or close connection-owned and replacement-incarnation terminals", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => makeFakePty() });
    const connectionOwned = await manager.open(baseOpenRequest());
    const replacementOwned = await manager.open(
      baseOpenRequest({
        owner: agentTerminalOwner(agentOwner.agentSessionKey, "replacement-session-id"),
      }),
    );
    if (!connectionOwned.ok || !replacementOwned.ok) {
      throw new Error("expected operator-opened terminals");
    }
    const tool = makeTool(manager);

    for (const sessionId of [connectionOwned.sessionId, replacementOwned.sessionId]) {
      for (const params of [
        { action: "read", sessionId },
        { action: "resize", sessionId, cols: 100, rows: 30 },
        { action: "close", sessionId },
      ]) {
        await expect(tool.execute(params.action, params)).rejects.toThrow(
          "Terminal session unavailable. Use action=list to find a shared terminal or ask the operator to open one in this chat.",
        );
      }
    }
    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(manager.size).toBe(2);
  });

  it.each([
    {
      label: "explicit exec denial",
      options: { config: { tools: { exec: { mode: "deny" } } }, execSession: {} },
    },
    { label: "read-only session", options: { execSession: { permissionMode: "read-only" } } },
  ] satisfies Array<{ label: string; options: TerminalToolOptions }>)(
    "rejects terminal input under $label without requesting approval",
    async ({ options }) => {
      const { backend, manager, sessionId } = await openAgentTerminal();
      const tool = makeTool(manager, options);

      await expect(
        tool.execute("blocked-input", { action: "input", sessionId, data: "echo unsafe\r" }),
      ).rejects.toThrow("Terminal input denied by execution policy");

      expect(backend.writes).toEqual([]);
      expect(approvalMocks.register).not.toHaveBeenCalled();
      expect(approvalMocks.decide).not.toHaveBeenCalled();
    },
  );

  it("preserves required-sandbox no-start through Code Mode before terminal input approval or write", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const harness = createSubscribedCodeModeHarness({ name: "terminal-sandbox-denial" });
    const terminal = wrapToolWithBeforeToolCallHook(
      makeTool(manager, {
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        execSession: { sandbox: "required" },
      }),
      { runId: harness.runId },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, terminal] });
    try {
      const details = resultDetails(
        await harness.tools[0]!.execute("terminal-input", {
          code: `return await terminal(${JSON.stringify({ action: "input", sessionId, data: "echo untouched\r" })});`,
        }),
      );
      expect(details).toMatchObject({ status: "failed", bridgeDispatchStarted: true });
      expect(details.error).toContain("sandbox runtime is unavailable");
      expect(backend.writes).toEqual([]);
      expect(approvalMocks.register).not.toHaveBeenCalled();
      expect(approvalMocks.decide).not.toHaveBeenCalled();
      expect(consumeRepairableCodeModeFailure(details)).toBe(true);
    } finally {
      harness.dispose();
      manager.closeAgent(agentOwner, sessionId);
    }
  });

  it("rejects terminal input when the authoritative persisted session is missing", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, { execSession: undefined });

    await expect(
      tool.execute("missing-session-input", { action: "input", sessionId, data: "echo unsafe\r" }),
    ).rejects.toThrow("Terminal session unavailable");

    expect(loadGatewaySessionEntryReadOnly).toHaveBeenCalledWith(agentOwner.agentSessionKey, {
      agentId: agentOwner.agentId,
      clone: false,
    });
    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "explicit full exec policy",
      options: { config: { tools: { exec: { mode: "full" } } }, execSession: {} },
    },
    { label: "full permission session", options: { execSession: { permissionMode: "full" } } },
  ] satisfies Array<{ label: string; options: TerminalToolOptions }>)(
    "writes exact-session terminal input immediately under $label",
    async ({ options }) => {
      const { backend, manager, sessionId } = await openAgentTerminal();
      const tool = makeTool(manager, options);

      await withActiveRun(manager, async () => {
        const result = await tool.execute("allowed-input", {
          action: "input",
          sessionId,
          data: "echo approved\r",
        });

        expect(result.details).toEqual({ ok: true });
      });

      expect(backend.writes).toEqual(["echo approved\r"]);
      expect(approvalMocks.register).not.toHaveBeenCalled();
      expect(approvalMocks.decide).not.toHaveBeenCalled();
    },
  );

  it("rejects full terminal input without an active admitted run", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, { execSession: { permissionMode: "full" } });

    await expect(
      tool.execute("unadmitted-full-input", {
        action: "input",
        sessionId,
        data: "echo unsafe\r",
      }),
    ).rejects.toThrow("agent run is no longer active");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it.each(["released", "replaced"] as const)(
    "rejects full terminal input after its exact run authority is %s",
    async (lifecycle) => {
      const { backend, manager, sessionId } = await openAgentTerminal();
      const tool = makeTool(manager, { execSession: { permissionMode: "full" } });

      await withActiveRun(manager, async (authority) => {
        const replacement =
          lifecycle === "replaced"
            ? claimAgentRunDelegatedAuthority({
                instanceId: "replacement-terminal-instance",
                runId: authority.operationalRunInstance.runId,
              })
            : undefined;
        if (!replacement) {
          releaseAgentRunDelegatedAuthority(authority);
        }

        try {
          await expect(
            tool.execute("stale-full-input", {
              action: "input",
              sessionId,
              data: "echo unsafe\r",
            }),
          ).rejects.toThrow("agent run is no longer active");
        } finally {
          if (replacement) {
            releaseAgentRunDelegatedAuthority(replacement);
          }
        }
      });

      expect(backend.writes).toEqual([]);
      expect(approvalMocks.register).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "guarded session", options: { execSession: { permissionMode: "guarded" } } },
    { label: "workspace session", options: { execSession: { permissionMode: "workspace" } } },
    {
      label: "allowlisted accept-only execution",
      options: { config: { tools: { exec: { mode: "allowlist" } } }, execSession: {} },
    },
  ] satisfies Array<{ label: string; options: TerminalToolOptions }>)(
    "requires a fresh explicit operator approval for every input in a $label",
    async ({ options }) => {
      const { backend, manager, sessionId } = await openAgentTerminal();
      const tool = makeTool(manager, {
        ...options,
        runId: "terminal-run",
        approvalReviewerDeviceIds: ["reviewer-device"],
      });

      await withActiveRun(manager, async () => {
        for (const [index, data] of ["echo first\r", "echo second\r"].entries()) {
          const result = await tool.execute(`guarded-input-${index}`, {
            action: "input",
            sessionId,
            data,
          });
          expect(result.details).toEqual({ ok: true });
        }
      });

      expect(backend.writes).toEqual(["echo first\r", "echo second\r"]);
      expect(approvalMocks.register).toHaveBeenCalledTimes(2);
      expect(approvalMocks.decide).toHaveBeenCalledTimes(2);
      expect(approvalMocks.register).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          approvalId: expect.any(String),
          command: `Terminal input: ${JSON.stringify("echo first\r")}`,
          host: "gateway",
          security: "allowlist",
          ask: "always",
          unavailableDecisions: ["allow-always"],
          agentId: "main",
          sessionKey: agentOwner.agentSessionKey,
          sessionId: agentOwner.agentSessionId,
          runId: "terminal-run",
          toolCallId: "guarded-input-0",
          approvalReviewerDeviceIds: ["reviewer-device"],
          requireDeliveryRoute: true,
        }),
      );
    },
  );

  it("waits for an explicit one-shot decision before writing guarded input", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, {
      execSession: { permissionMode: "guarded" },
      runId: "terminal-run",
    });
    let resolveDecision!: (decision: string) => void;
    approvalMocks.decide.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveDecision = resolve;
        }),
    );

    await withActiveRun(manager, async () => {
      const pending = tool.execute("pending-input", {
        action: "input",
        sessionId,
        data: "echo pending\r",
      });
      await vi.waitFor(() => expect(approvalMocks.decide).toHaveBeenCalledOnce());
      expect(backend.writes).toEqual([]);

      resolveDecision("allow-once");
      await expect(pending).resolves.toMatchObject({ details: { ok: true } });
    });

    expect(backend.writes).toEqual(["echo pending\r"]);
  });

  it.each(["deny", "allow-always", null])(
    "rejects guarded input when the operator decision is %s",
    async (decision) => {
      const { backend, manager, sessionId } = await openAgentTerminal();
      const tool = makeTool(manager, { execSession: { permissionMode: "guarded" } });
      approvalMocks.decide.mockResolvedValueOnce(decision);

      await withActiveRun(manager, async () => {
        await expect(
          tool.execute("rejected-input", { action: "input", sessionId, data: "echo rejected\r" }),
        ).rejects.toThrow("operator approval required");
      });

      expect(backend.writes).toEqual([]);
    },
  );

  it("rejects guarded input when no operator approval route is available", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, { execSession: { permissionMode: "guarded" } });
    approvalMocks.register.mockRejectedValueOnce(new Error("no approval delivery route"));

    await withActiveRun(manager, async () => {
      await expect(
        tool.execute("unroutable-input", { action: "input", sessionId, data: "echo unsafe\r" }),
      ).rejects.toThrow(/approval|route/i);
    });

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.decide).not.toHaveBeenCalled();
  });

  it("rejects guarded input that loses its exact run authority during operator approval", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, { execSession: { permissionMode: "guarded" } });

    await withActiveRun(manager, async (authority) => {
      approvalMocks.decide.mockImplementationOnce(async () => {
        releaseAgentRunDelegatedAuthority(authority);
        return "allow-once";
      });

      await expect(
        tool.execute("stale-run-input", { action: "input", sessionId, data: "echo unsafe\r" }),
      ).rejects.toThrow("agent run is no longer active");
    });

    expect(backend.writes).toEqual([]);
  });

  it("rejects guarded input that loses its terminal session during operator approval", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, { execSession: { permissionMode: "guarded" } });
    approvalMocks.decide.mockImplementationOnce(async () => {
      manager.closeAgent(agentOwner, sessionId);
      return "allow-once";
    });

    await withActiveRun(manager, async () => {
      await expect(
        tool.execute("stale-session-input", { action: "input", sessionId, data: "echo unsafe\r" }),
      ).rejects.toThrow("Terminal session unavailable");
    });

    expect(backend.writes).toEqual([]);
  });

  it("rejects guarded input when its admitted Gateway changes during operator approval", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const replacement = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    let currentManager = manager;
    const tool = makeTool(manager, {
      execSession: { permissionMode: "guarded" },
      getGatewayContext: () => makeContext(currentManager),
    });
    approvalMocks.decide.mockImplementationOnce(async () => {
      currentManager = replacement;
      return "allow-once";
    });

    await withActiveRun(manager, async () => {
      await expect(
        tool.execute("stale-gateway-input", { action: "input", sessionId, data: "echo unsafe\r" }),
      ).rejects.toThrow("Terminal session unavailable");
    });

    expect(backend.writes).toEqual([]);
  });

  it("rejects guarded input outside an active admitted agent run", async () => {
    const { backend, manager, sessionId } = await openAgentTerminal();
    const tool = makeTool(manager, { execSession: { permissionMode: "guarded" } });

    await expect(
      tool.execute("missing-run-input", { action: "input", sessionId, data: "echo unsafe\r" }),
    ).rejects.toThrow("agent run is no longer active");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it.each([
    { options: { sessionId: "main-session-id" }, error: "agent session required" },
    { options: { agentSessionKey: "agent:main:main" }, error: "agent session id required" },
  ])("requires exact session ownership before reading: $error", async ({ options, error }) => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const tool = createTerminalTool({
      ...options,
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("list", { action: "list" })).rejects.toThrow(error);
  });
});

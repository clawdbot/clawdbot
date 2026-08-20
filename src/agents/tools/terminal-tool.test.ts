import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_OPEN_DEADLINE_MS } from "../../gateway/terminal/open-deadline.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import {
  bindAgentRunTaskRunId,
  claimAgentRunContext,
  getAgentRunContext,
  getAgentRunTaskRunId,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import type { spawnTerminalPty } from "../../process/terminal-pty.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createTerminalTool } from "./terminal-tool.js";

const callInProcessGatewayTool = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
// Stub the host exec-approvals file so the real resolveTerminalExecPolicyDefault
// path (which calls loadExecApprovals) does not read the developer's production
// ~/.openclaw/exec-approvals.json. Returning an empty file lets the default
// resolver run for real, exercising the session-permission short-circuit.
const loadExecApprovalsMock = vi.hoisted(() => vi.fn(() => ({ version: 1 }) as const));

vi.mock("./in-process-gateway.js", () => ({
  callInProcessGatewayTool,
  getInProcessGatewayToolContext: vi.fn(),
}));

vi.mock("../../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/exec-approvals.js")>();
  return { ...actual, loadExecApprovals: loadExecApprovalsMock };
});

type TerminalPtyHandle = Awaited<ReturnType<typeof spawnTerminalPty>>;

function makeBackend() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const backend: TerminalPtyHandle & {
    writes: string[];
    resizes: Array<[number, number]>;
    killed: boolean;
    emitData(data: string): void;
    emitExit(code: number): void;
  } = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    write: (data) => backend.writes.push(data),
    resize: (cols, rows) => backend.resizes.push([cols, rows]),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: () => {
      backend.killed = true;
    },
    onData: (listener) => {
      onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    emitData: (data) => onData?.(data),
    emitExit: (code) => onExit?.({ exitCode: code }),
  };
  return backend;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeContext(manager: TerminalSessionManager) {
  return {
    terminalSessions: manager,
    isTerminalEnabled: () => true,
    resolveTerminalLaunchPolicy: () => ({
      ok: true as const,
      plan: {
        agentId: "main",
        cwd: "/tmp",
        shell: "/bin/sh",
        args: [],
      },
    }),
  };
}

function makeContextWithConfig(manager: TerminalSessionManager, cfg: unknown) {
  return {
    ...makeContext(manager),
    getRuntimeConfig: () => cfg,
  };
}

const allowExecPolicy = () => ({
  mode: "full" as const,
  security: "full" as const,
  ask: "off" as const,
});

type TerminalApprovalRequesterParams = {
  agentId: string;
  agentSessionKey: string;
  runId?: string;
  toolCallId?: string;
  shell: string;
  args: string[];
  cwd: string;
  initialCommand?: string;
  security: string;
  ask: string;
};

describe("terminal tool", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    callInProcessGatewayTool.mockClear();
  });

  it("uses a flat action enum and the owner-only core gate", () => {
    const tool = createTerminalTool();
    expect(tool.description).toContain(
      "Terminals opened from this chat's Control UI panel are shared with the agent",
    );
    expect(tool.parameters).toMatchObject({
      properties: {
        action: {
          type: "string",
          enum: ["open", "read", "input", "resize", "close", "list"],
        },
      },
    });
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("show");
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("terminal");
  });

  it("opens in the background, reads, writes, resizes, lists, and closes its terminal", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: allowExecPolicy,
      getGatewayContext: () => makeContext(manager),
    });
    expect(tool.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ sessions: Array<{ agentId: string; attached: boolean; createdAtMs: number; cwd: string; owner: string; sessionId: string; shell: string }> } | { agentId: string; cwd: string; ok: true; sessionId: string; shell: string } | { sessionId: string; text: string } | { ok: true }",
    );

    const opened = await tool.execute("open", { action: "open", command: "echo ready" });
    expect(Value.Check(tool.outputSchema!, opened.details)).toBe(true);
    const sessionId = (opened.details as { sessionId: string }).sessionId;
    expect(backend.writes).toEqual(["echo ready\r"]);
    expect(callInProcessGatewayTool).not.toHaveBeenCalled();

    backend.emitData("\u001b[31mready\u001b[0m\r\n");
    const read = await tool.execute("read", { action: "read", sessionId });
    expect(read.details).toEqual({ sessionId, text: "ready\n" });
    expect(Value.Check(tool.outputSchema!, read.details)).toBe(true);

    const input = await tool.execute("input", { action: "input", sessionId, data: "yes\r" });
    expect(input.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, input.details)).toBe(true);
    expect(backend.writes).toEqual(["echo ready\r", "yes\r"]);
    const resize = await tool.execute("resize", {
      action: "resize",
      sessionId,
      cols: 120,
      rows: 40,
    });
    expect(resize.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, resize.details)).toBe(true);
    expect(backend.resizes).toEqual([[120, 40]]);

    const list = await tool.execute("list", { action: "list" });
    expect(list.details).toEqual({
      sessions: [
        expect.objectContaining({
          sessionId,
          owner: "agent:agent:main:main",
        }),
      ],
    });
    expect(Value.Check(tool.outputSchema!, list.details)).toBe(true);
    const closed = await tool.execute("close", { action: "close", sessionId });
    expect(closed.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, closed.details)).toBe(true);
    expect(backend.killed).toBe(true);
  });

  it("binds the exact run when two active tasks share one child session", async () => {
    const firstBackend = makeBackend();
    const secondBackend = makeBackend();
    const persistentBackend = makeBackend();
    const backends = [firstBackend, secondBackend, persistentBackend];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => backends.shift() ?? makeBackend(),
    });
    const agentSessionKey = "agent:main:shared-task-session";
    const lookupTaskByRunIdForChildSession = vi.fn(async (runId: string) =>
      runId === "conversation-run"
        ? undefined
        : {
            taskId: runId === "run-1" ? "task-1" : "task-2",
            status: "running" as const,
            childSessionKey: agentSessionKey,
          },
    );
    const createTaskTool = (runId: string) =>
      createTerminalTool({
        agentId: "main",
        agentSessionKey,
        sessionId: "shared-session-id",
        resolveExecPolicy: allowExecPolicy,
        runId,
        lookupTaskByRunIdForChildSession,
        getGatewayContext: () => makeContext(manager),
      });

    await createTaskTool("run-1").execute("open", { action: "open" });
    await createTaskTool("run-2").execute("open", { action: "open" });
    await createTaskTool("conversation-run").execute("open", { action: "open" });

    expect(lookupTaskByRunIdForChildSession.mock.calls).toEqual([
      ["run-1", agentSessionKey],
      ["run-2", agentSessionKey],
      ["conversation-run", agentSessionKey],
    ]);
    expect(manager.closeTaskSessions("task-1")).toBe(1);
    expect(firstBackend.killed).toBe(true);
    expect(secondBackend.killed).toBe(false);
    expect(persistentBackend.killed).toBe(false);
    expect(
      manager.listAgent({
        kind: "agent",
        agentSessionKey,
        agentSessionId: "shared-session-id",
        agentId: "main",
      }),
    ).toHaveLength(2);
  });

  it("binds the matching child session when task run ids collide", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const agentSessionKey = "agent:main:shared-run-task-2";
    const tasks = [
      {
        taskId: "task-1",
        status: "running" as const,
        childSessionKey: "agent:main:shared-run-task-1",
      },
      {
        taskId: "task-2",
        status: "running" as const,
        childSessionKey: agentSessionKey,
      },
    ];
    const lookupTaskByRunIdForChildSession = vi.fn(
      async (_runId: string, childSessionKey: string) =>
        tasks.find((task) => task.childSessionKey === childSessionKey),
    );
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey,
      sessionId: "shared-run-session-id",
      runId: "shared-run",
      resolveExecPolicy: allowExecPolicy,
      lookupTaskByRunIdForChildSession,
      getGatewayContext: () => makeContext(manager),
    });

    await tool.execute("open", { action: "open" });

    expect(lookupTaskByRunIdForChildSession).toHaveBeenCalledWith("shared-run", agentSessionKey);
    expect(manager.closeTaskSessions("task-2")).toBe(1);
    expect(manager.closeTaskSessions("task-1")).toBe(0);
    expect(backend.killed).toBe(true);
  });

  it("maps a cron agent run to its detached task before terminal lookup", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const agentSessionKey = "agent:main:cron-task-session";
    const claimId = claimAgentRunContext(
      "cron-agent-run",
      { sessionKey: agentSessionKey },
      { trackOwner: true, ownsContext: true },
    );
    expect(claimId).toBeTruthy();
    if (!claimId) {
      throw new Error("expected cron agent run claim");
    }
    expect(bindAgentRunTaskRunId("cron-agent-run", claimId, "detached-task-run")).toBe(true);
    const lookupTaskByRunIdForChildSession = vi.fn(async () => ({
      taskId: "cron-task",
      status: "running" as const,
      childSessionKey: agentSessionKey,
    }));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey,
      sessionId: "cron-session-id",
      runId: "cron-agent-run",
      resolveExecPolicy: allowExecPolicy,
      lookupTaskByRunIdForChildSession,
      getGatewayContext: () => makeContext(manager),
    });

    try {
      await tool.execute("open", { action: "open" });

      expect(lookupTaskByRunIdForChildSession).toHaveBeenCalledWith(
        "detached-task-run",
        agentSessionKey,
      );
      expect(manager.closeTaskSessions("cron-task")).toBe(1);
      expect(backend.killed).toBe(true);
    } finally {
      releaseAgentRunContext("cron-agent-run", claimId);
    }

    expect(getAgentRunTaskRunId("cron-agent-run")).toBeUndefined();
    expect(getAgentRunContext("cron-agent-run")).toBeUndefined();
  });

  it("refuses an open when its exact task is already terminal", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:completed-task",
      sessionId: "completed-session-id",
      runId: "completed-run",
      resolveExecPolicy: allowExecPolicy,
      lookupTaskByRunIdForChildSession: vi.fn(async () => ({
        taskId: "task-completed",
        status: "succeeded" as const,
        childSessionKey: "agent:main:completed-task",
      })),
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "terminal task already ended",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("fails closed when launch policy blocks the agent", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: false,
          block: { kind: "sandboxed", agentId: "main", mode: "all" },
        }),
      }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "terminal unavailable: agent sandboxed (all)",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves an explicit-owner launch failure", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: false,
          block: { kind: "owner-required", message: "select an agent explicitly" },
        }),
      }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "select an agent explicitly",
    );
  });

  it("does not open while the terminal surface is disabled", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        ...makeContext(manager),
        isTerminalEnabled: () => false,
      }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow("terminal disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("validates open arguments before allocating a terminal", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open", command: 42 })).rejects.toThrow(
      "command must be string",
    );
    await expect(tool.execute("open", { action: "open", cwd: 42 })).rejects.toThrow(
      "cwd must be string",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("bounds terminal creation and kills a backend that arrives after timeout", async () => {
    vi.useFakeTimers();
    try {
      const spawned = deferred<ReturnType<typeof makeBackend>>();
      const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: () => spawned.promise });
      const tool = createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:main",
        sessionId: "main-session-id",
        resolveExecPolicy: allowExecPolicy,
        getGatewayContext: () => makeContext(manager),
      });
      const opening = tool.execute("open", { action: "open" });
      const timedOut = expect(opening).rejects.toThrow("terminal open timed out");

      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);
      await timedOut;

      const backend = makeBackend();
      spawned.resolve(backend);
      await vi.waitFor(() => expect(backend.killed).toBe(true));
      expect(manager.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot list or operate connection-owned and replacement-incarnation terminals", async () => {
    const connBackend = makeBackend();
    const otherBackend = makeBackend();
    const backends = [connBackend, otherBackend];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => backends.shift() ?? makeBackend(),
    });
    const conn = await manager.open({
      owner: { kind: "conn", connId: "operator" },
      agentId: "main",
      cwd: "/tmp",
      shell: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      env: {},
    });
    const other = await manager.open({
      owner: {
        kind: "agent",
        agentSessionKey: "agent:main:main",
        agentSessionId: "replacement-session-id",
        agentId: "main",
      },
      agentId: "main",
      cwd: "/tmp",
      shell: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      env: {},
    });
    if (!conn.ok || !other.ok) {
      throw new Error("expected opens");
    }
    const tool = createTerminalTool({
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => makeContext(manager),
    });

    for (const sessionId of [conn.sessionId, other.sessionId]) {
      await expect(tool.execute("read", { action: "read", sessionId })).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
      await expect(
        tool.execute("input", { action: "input", sessionId, data: "blocked" }),
      ).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
      await expect(
        tool.execute("resize", { action: "resize", sessionId, cols: 120, rows: 40 }),
      ).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
      await expect(tool.execute("close", { action: "close", sessionId })).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
    }
    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(connBackend.writes).toEqual([]);
    expect(otherBackend.writes).toEqual([]);
    expect(connBackend.killed).toBe(false);
    expect(otherBackend.killed).toBe(false);
  });

  it.each([
    {
      name: "initial command",
      configure: (backend: ReturnType<typeof makeBackend>) => {
        backend.write = () => {
          throw new Error("write failed");
        };
      },
      execute: (tool: ReturnType<typeof createTerminalTool>) =>
        tool.execute("open", { action: "open", command: "echo ready" }),
    },
    {
      name: "input",
      configure: (backend: ReturnType<typeof makeBackend>) => {
        backend.write = () => {
          throw new Error("write failed");
        };
      },
      execute: async (tool: ReturnType<typeof createTerminalTool>) => {
        const opened = await tool.execute("open", { action: "open" });
        const sessionId = (opened.details as { sessionId: string }).sessionId;
        return tool.execute("input", { action: "input", sessionId, data: "yes\r" });
      },
    },
    {
      name: "resize",
      configure: (backend: ReturnType<typeof makeBackend>) => {
        backend.resize = () => {
          throw new Error("resize failed");
        };
      },
      execute: async (tool: ReturnType<typeof createTerminalTool>) => {
        const opened = await tool.execute("open", { action: "open" });
        const sessionId = (opened.details as { sessionId: string }).sessionId;
        return tool.execute("resize", { action: "resize", sessionId, cols: 120, rows: 40 });
      },
    },
  ])(
    "throws actionable recovery when backend $name fails",
    async ({ name, configure, execute }) => {
      const backend = makeBackend();
      configure(backend);
      const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
      const tool = createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:main",
        sessionId: "main-session-id",
        getGatewayContext: () => makeContext(manager),
      });

      await expect(execute(tool)).rejects.toThrow(
        `Terminal ${name} failed. Use action=list to find an owned terminal or action=open to acquire one.`,
      );
      expect(manager.size).toBe(0);
    },
  );
  it("refuses to open a terminal when exec policy denies host execution", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: () => ({ mode: "deny", security: "deny", ask: "off" }),
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "exec policy denies host command execution",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("denies a read-only session even when global exec policy is full", async () => {
    // The restriction comes ONLY from the prepared session permission policy
    // (read-only → deny). Without carrying it into the terminal's policy
    // resolution, a permissive global config would let a restricted session
    // open a host PTY.
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      sessionPermissionPolicy: { root: "/workspace", mode: "read-only" },
      getGatewayContext: () =>
        makeContextWithConfig(manager, { tools: { exec: { mode: "full" } } }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "exec policy denies host command execution",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("prompts for approval on a guarded session under global full exec", async () => {
    // guarded → ask: the terminal must route through the approval flow rather
    // than opening silently under the permissive global policy.
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const requestTerminalApproval = vi.fn<
      (params: TerminalApprovalRequesterParams) => Promise<boolean>
    >(async () => true);
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      sessionPermissionPolicy: { root: "/workspace", mode: "guarded" },
      requestTerminalApproval,
      getGatewayContext: () =>
        makeContextWithConfig(manager, { tools: { exec: { mode: "full" } } }),
    });

    const opened = await tool.execute("open", { action: "open" });
    expect(requestTerminalApproval).toHaveBeenCalledTimes(1);
    expect(opened.details).toMatchObject({ ok: true });
  });

  it("denies a terminal when a per-run exec override sets security deny under global full", async () => {
    // The exec tool honors a run-level security override; the terminal must too,
    // so a per-run deny cannot be bypassed by opening a terminal instead.
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      execOverrides: { security: "deny" },
      getGatewayContext: () =>
        makeContextWithConfig(manager, { tools: { exec: { mode: "full" } } }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "exec policy denies host command execution",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("routes a workspace session through approval under global full exec", async () => {
    // workspace → auto → ask:on-miss: the session-permission short-circuit
    // replaces the permissive global full, so the terminal must route through
    // the approval flow rather than opening silently.
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const requestTerminalApproval = vi.fn<
      (params: TerminalApprovalRequesterParams) => Promise<boolean>
    >(async () => true);
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      sessionPermissionPolicy: { root: "/workspace", mode: "workspace" },
      requestTerminalApproval,
      getGatewayContext: () =>
        makeContextWithConfig(manager, { tools: { exec: { mode: "full" } } }),
    });

    const opened = await tool.execute("open", { action: "open" });
    expect(requestTerminalApproval).toHaveBeenCalledTimes(1);
    expect(opened.details).toMatchObject({ ok: true });
  });

  it("refuses to open a terminal under allowlist-only exec policy", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: () => ({ mode: "allowlist", security: "allowlist", ask: "off" }),
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow("allowlist-only");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("opens a terminal after an allow-once exec approval", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const requestTerminalApproval = vi.fn<
      (params: TerminalApprovalRequesterParams) => Promise<boolean>
    >(async () => true);
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: () => ({ mode: "ask", security: "allowlist", ask: "on-miss" }),
      requestTerminalApproval,
      getGatewayContext: () => makeContext(manager),
    });

    const opened = await tool.execute("open", { action: "open" });
    expect(requestTerminalApproval).toHaveBeenCalledTimes(1);
    expect(requestTerminalApproval.mock.calls[0]![0]).toMatchObject({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      shell: "/bin/sh",
      cwd: "/tmp",
    });
    expect(opened.details).toMatchObject({ ok: true });
    expect(manager.size).toBe(1);
  });

  it("refuses to open a terminal when exec approval is not granted", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const requestTerminalApproval = vi.fn<
      (params: TerminalApprovalRequesterParams) => Promise<boolean>
    >(async () => false);
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: () => ({ mode: "ask", security: "allowlist", ask: "on-miss" }),
      requestTerminalApproval,
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "exec approval not granted",
    );
    expect(requestTerminalApproval).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("refuses to open a terminal when the non-interactive approval policy is active", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const requestTerminalApproval = vi.fn<
      (params: TerminalApprovalRequesterParams) => Promise<boolean>
    >(async () => true);
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: () => ({ mode: "ask", security: "allowlist", ask: "on-miss" }),
      requestTerminalApproval,
      nonInteractiveApproval: true,
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "non-interactive approval policy denies",
    );
    expect(requestTerminalApproval).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when the requesting run aborts while approval is pending", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const controller = new AbortController();
    // Simulate the run aborting (closure/rotation) while the operator approval
    // is still pending: the approval resolves true, but the run signal has
    // already aborted by the time the await returns.
    const requestTerminalApproval = vi.fn<
      (params: TerminalApprovalRequesterParams) => Promise<boolean>
    >(async () => {
      controller.abort(new Error("run closed during approval"));
      return true;
    });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      resolveExecPolicy: () => ({ mode: "ask", security: "allowlist", ask: "on-miss" }),
      requestTerminalApproval,
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" }, controller.signal)).rejects.toThrow(
      "requesting run is no longer active",
    );
    expect(requestTerminalApproval).toHaveBeenCalledTimes(1);
    // A stale run must fail closed before any gateway-host PTY is spawned.
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });
});

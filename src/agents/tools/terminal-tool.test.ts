import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { TERMINAL_OPEN_DEADLINE_MS } from "../../gateway/terminal/open-deadline.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import type { spawnTerminalPty } from "../../process/terminal-pty.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import { createTerminalTool } from "./terminal-tool.js";

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

describe("terminal tool", () => {
  it("uses a flat action enum and the owner-only core gate", () => {
    const tool = createTerminalTool();
    expect(tool.parameters).toMatchObject({
      properties: {
        action: {
          type: "string",
          enum: ["open", "read", "input", "resize", "close", "list"],
        },
      },
    });
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("terminal");
  });

  it("opens, shows, reads, writes, resizes, lists, and closes its terminal", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const callGateway = vi.fn(async () => ({ ok: true })) as InProcessGatewayCaller;
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      callGateway,
      getGatewayContext: () => makeContext(manager),
    });
    expect(tool.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ sessions: Array<{ agentId: string; attached: boolean; createdAtMs: number; cwd: string; owner: string; sessionId: string; shell: string }> } | { agentId: string; cwd: string; ok: true; sessionId: string; shell: string } | { sessionId: string; text: string } | { ok: boolean }",
    );

    const opened = await tool.execute("open", { action: "open", command: "echo ready" });
    expect(Value.Check(tool.outputSchema!, opened.details)).toBe(true);
    const sessionId = (opened.details as { sessionId: string }).sessionId;
    expect(backend.writes).toEqual(["echo ready\r"]);
    expect(callGateway).toHaveBeenCalledWith("ui.command", {
      command: {
        kind: "panel",
        panel: "terminal",
        open: true,
        terminalSessionId: sessionId,
      },
      sessionKey: "agent:main:main",
    });

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

  it("fails closed when launch policy blocks the agent", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
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

  it("does not open while the terminal surface is disabled", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
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
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open", show: "yes" })).rejects.toThrow(
      "show must be boolean",
    );
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

  it("cannot read, input, or close connection-owned and other-agent terminals", async () => {
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
      owner: { kind: "agent", agentSessionKey: "agent:main:other" },
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
      getGatewayContext: () => makeContext(manager),
    });

    for (const sessionId of [conn.sessionId, other.sessionId]) {
      await expect(tool.execute("read", { action: "read", sessionId })).rejects.toThrow(
        "terminal not owned by this agent session",
      );
      await expect(
        tool.execute("input", { action: "input", sessionId, data: "blocked" }),
      ).resolves.toMatchObject({ details: { ok: false } });
      await expect(
        tool.execute("resize", { action: "resize", sessionId, cols: 120, rows: 40 }),
      ).resolves.toMatchObject({ details: { ok: false } });
      await expect(tool.execute("close", { action: "close", sessionId })).resolves.toMatchObject({
        details: { ok: false },
      });
    }
    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(connBackend.writes).toEqual([]);
    expect(otherBackend.writes).toEqual([]);
    expect(connBackend.killed).toBe(false);
    expect(otherBackend.killed).toBe(false);
  });
});

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { makeFakePty } from "../terminal/session-manager.test-helpers.js";
import { terminalHandlers } from "./terminal.js";

describe("terminal.close/attach padded sessionId", () => {
  it("closes a live connection-owned PTY when terminal.close receives a padded sessionId", async () => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const opened = await manager.open({
      owner: { kind: "conn", connId: "conn-pad" },
      agentId: "main",
      cwd: "/tmp",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const padded = ` ${opened.sessionId} `;
    // Negative control: exact Map key differs from clipboard-padded RPC input.
    expect(padded).not.toBe(opened.sessionId);
    expect(manager.size).toBe(1);

    const respond = vi.fn();
    await expectDefined(terminalHandlers["terminal.close"], "terminal.close")({
      params: { sessionId: padded },
      respond,
      context: {
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        getRuntimeConfig: () => ({ gateway: { terminal: { enabled: true } } }),
      },
      client: { connId: "conn-pad", connect: {} },
      isWebchatConnect: () => false,
      req: { type: "req", id: "2", method: "terminal.close" },
    } as never);

    expect(respond).toHaveBeenCalledWith(true, { ok: true });
    expect(manager.size).toBe(0);
  });

  it("attaches to a detached session when terminal.attach receives a padded sessionId", async () => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => backend,
      detachGraceMs: 60_000,
    });
    const opened = await manager.open({
      owner: { kind: "conn", connId: "conn-owner" },
      agentId: "main",
      cwd: "/tmp",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    manager.handleDisconnect("conn-owner");

    const padded = ` ${opened.sessionId} `;
    const respond = vi.fn();
    await expectDefined(terminalHandlers["terminal.attach"], "terminal.attach")({
      params: { sessionId: padded },
      respond,
      context: {
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        getRuntimeConfig: () => ({ gateway: { terminal: { enabled: true } } }),
        logGateway: { info: vi.fn() },
      },
      client: { connId: "conn-owner", connect: {} },
      isWebchatConnect: () => false,
      req: { type: "req", id: "3", method: "terminal.attach" },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId: opened.sessionId }),
    );
  });
});

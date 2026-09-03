import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "./terminal/session-manager.test-helpers.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools terminal ownership", () => {
  it("preserves exact-session controls while applying the configured execution denial", async () => {
    const currentPty = makeFakePty();
    const otherPty = makeFakePty();
    const ptys = [currentPty, otherPty];
    const spawn = vi.fn(async () => ptys.shift() ?? makeFakePty());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const childSessionKey = "agent:main:loopback-task-2";
    const current = await manager.open(
      baseOpenRequest({ owner: agentTerminalOwner(childSessionKey, "loopback-session-id") }),
    );
    const other = await manager.open(
      baseOpenRequest({ owner: agentTerminalOwner("agent:main:loopback-task-1") }),
    );
    if (!current.ok || !other.ok) {
      throw new Error("expected operator-opened terminals");
    }
    currentPty.emitData("current session output\n");
    const context = { terminalSessions: manager } as unknown as GatewayRequestContext;

    try {
      const result = withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        () =>
          resolveGatewayScopedTools({
            cfg: { tools: { allow: ["terminal"], exec: { mode: "deny" } } } as OpenClawConfig,
            sessionKey: childSessionKey,
            sessionId: "loopback-session-id",
            execSession: { permissionMode: "read-only" },
            runId: "shared-run",
            senderIsOwner: true,
            surface: "loopback",
          }),
      );
      const terminal = result.tools.find((tool) => tool.name === "terminal");
      if (!terminal?.execute) {
        throw new Error("expected loopback terminal tool");
      }
      const execute = (params: Record<string, unknown>) =>
        withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
          terminal.execute!("terminal-tool", params),
        );

      await expect(execute({ action: "list" })).resolves.toMatchObject({
        details: { sessions: [expect.objectContaining({ sessionId: current.sessionId })] },
      });
      await expect(
        execute({ action: "read", sessionId: current.sessionId }),
      ).resolves.toMatchObject({
        details: { sessionId: current.sessionId, text: "current session output\n" },
      });
      await expect(execute({ action: "read", sessionId: other.sessionId })).rejects.toThrow(
        "Terminal session unavailable",
      );
      await expect(
        execute({ action: "resize", sessionId: other.sessionId, cols: 100, rows: 30 }),
      ).rejects.toThrow("Terminal session unavailable");
      await expect(
        execute({ action: "resize", sessionId: current.sessionId, cols: 100, rows: 30 }),
      ).resolves.toMatchObject({ details: { ok: true } });
      expect(currentPty.resizes).toEqual([[100, 30]]);
      spawn.mockClear();
      await expect(execute({ action: "open" })).rejects.toThrow("terminal action unavailable");
      await expect(
        execute({ action: "input", sessionId: current.sessionId, data: "unsafe\r" }),
      ).rejects.toThrow("Terminal input denied by execution policy");
      expect(spawn).not.toHaveBeenCalled();
      expect(currentPty.writes).toEqual([]);
      expect(otherPty.writes).toEqual([]);

      await expect(execute({ action: "close", sessionId: other.sessionId })).rejects.toThrow(
        "Terminal session unavailable",
      );
      await expect(
        execute({ action: "close", sessionId: current.sessionId }),
      ).resolves.toMatchObject({ details: { ok: true } });
      expect(currentPty.killed).toBe(true);
      expect(otherPty.killed).toBe(false);
    } finally {
      manager.disposeAll();
    }
  });
});

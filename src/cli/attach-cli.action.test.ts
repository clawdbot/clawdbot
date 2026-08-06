import { EventEmitter } from "node:events";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnedChild = Object.assign(new EventEmitter(), { kill: vi.fn() });
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => spawnedChild) }));

const gatewayCalls: Array<{
  method: string;
  params: Record<string, unknown>;
  mode?: string;
  hasDeviceIdentityKey: boolean;
}> = [];

function gatewayParams(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError("Expected gateway params to be an object");
  }
  return params as Record<string, unknown>;
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(
    async (p: { method: string; params: Record<string, unknown>; mode?: string }) => {
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      if (p.method === "attach.grant") {
        const sessionKey = (p.params.sessionKey as string) ?? "agent:main:main";
        return {
          sessionKey,
          token: "tok-123",
          expiresAtMs: 2_000_000_000_000,
          mcpConfig: {
            mcpServers: {
              openclaw: {
                type: "http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
              },
            },
          },
          env: { OPENCLAW_MCP_TOKEN: "tok-123" },
        };
      }
      return {};
    },
  ),
}));

const logs: string[] = [];
let exitCode: number | undefined;
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (m: string) => logs.push(m),
    error: (m: string) => logs.push(`ERR:${m}`),
    exit: (c: number) => {
      exitCode = c;
    },
  },
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

import { callGateway } from "../gateway/call.js";
import { registerAttachCli } from "./attach-cli.js";

async function runAttach(...args: string[]) {
  const program = new Command().name("openclaw").exitOverride();
  await registerAttachCli(program);
  await program.parseAsync(["node", "openclaw", "attach", ...args]);
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("openclaw attach (action)", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    logs.length = 0;
    exitCode = undefined;
    spawnedChild.removeAllListeners();
    spawnedChild.kill.mockClear();
  });

  it("--print-config: mints + writes config + prints launch, does NOT revoke or name a nonexistent command", async () => {
    await runAttach("--print-config", "--session", "agent:main:cli");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")?.params.sessionKey).toBe(
      "agent:main:cli",
    );
    // setup mode leaves the grant live (no revoke) and must not point at a revoke command that does not exist
    expect(gatewayCalls.find((c) => c.method === "attach.revoke")).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("agent:main:cli");
    expect(out).toContain("--mcp-config");
    expect(out).toContain("--strict-mcp-config");
    expect(out).toContain("OPENCLAW_MCP_TOKEN");
    expect(out).not.toContain("attach.revoke");
  });

  it("calls attach.grant in CLI mode with an auto-resolved device identity (operator.admin regression guard)", async () => {
    // Regression guard: attach.grant is operator.admin-scoped. mode BACKEND or an explicit
    // deviceIdentity:null drops the operator device identity → the gateway rejects with
    // "missing scope: operator.admin". This was a real bug found via a live-gateway proof.
    await runAttach("--print-config", "--session", "agent:main:cli");
    const grant = gatewayCalls.find((c) => c.method === "attach.grant");
    expect(grant?.mode).toBe("cli");
    expect(grant?.hasDeviceIdentityKey).toBe(false);
  });

  it("rejects a non-positive --ttl before minting", async () => {
    await runAttach("--ttl", "-5", "--print-config");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it.each(["0x10", "1.5", "1e3"])("rejects malformed --ttl %s before minting", async (ttl) => {
    await runAttach("--ttl", ttl, "--print-config");
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--ttl must be a positive integer of milliseconds");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it("rejects an empty --ttl rather than silently defaulting", async () => {
    await runAttach("--ttl", "", "--print-config");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it("passes a positive --ttl through to attach.grant", async () => {
    await runAttach("--ttl", "600000", "--print-config");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")?.params.ttlMs).toBe(600_000);
  });

  it("errors on a malformed attach.grant response instead of crashing", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({} as never);
    await runAttach("--print-config");
    expect(exitCode).toBe(1);
  });

  it("spawns Claude Code and revokes the grant when the child exits", async () => {
    await runAttach("--session", "agent:main:spawn");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeTruthy();
    const { spawn } = await import("node:child_process");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      expect.stringContaining(".mcp.json"),
    ]);
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(gatewayCalls.find((c) => c.method === "attach.revoke")?.params.token).toBe("tok-123");
    expect(exitCode).toBe(0);
  });

  it("revokes once and surfaces a launch failure when the child errors", async () => {
    await runAttach("--session", "agent:main:spawn-err");
    spawnedChild.emit("error", new Error("ENOENT"));
    await tick();
    await tick();
    expect(gatewayCalls.filter((c) => c.method === "attach.revoke")).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Failed to launch");
  });

  it("warns when revoke fails but still exits with the child status", async () => {
    vi.mocked(callGateway).mockImplementationOnce(async (p) => {
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      return {
        sessionKey: "agent:main:spawn",
        token: "tok-123",
        expiresAtMs: 2_000_000_000_000,
        mcpConfig: { mcpServers: { openclaw: {} } },
        env: { OPENCLAW_MCP_TOKEN: "tok-123" },
      } as never;
    });
    vi.mocked(callGateway).mockImplementationOnce(async (p) => {
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      throw new Error("gateway down");
    });

    await runAttach("--session", "agent:main:spawn");
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("failed to revoke attach grant");
  });

  it("detaches its signal handlers after the child exits (no listener leak)", async () => {
    const baseInt = process.listenerCount("SIGINT");
    const baseTerm = process.listenerCount("SIGTERM");
    await runAttach("--session", "agent:main:spawn");
    expect(process.listenerCount("SIGINT")).toBe(baseInt + 1);
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(process.listenerCount("SIGINT")).toBe(baseInt);
    expect(process.listenerCount("SIGTERM")).toBe(baseTerm);
  });

  it("errors on a grant with a non-numeric expiresAtMs instead of crashing on toISOString", async () => {
    vi.mocked(callGateway).mockResolvedValueOnce({
      sessionKey: "agent:main:x",
      token: "tok-123",
      expiresAtMs: "soon",
      mcpConfig: { mcpServers: { openclaw: {} } },
      env: {},
    } as never);
    await runAttach("--print-config");
    expect(exitCode).toBe(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(
  connId: string,
  nodeId: string,
  sent: string[] = [],
  opts: { clientId?: string; platform?: string; version?: string } = {},
): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      send(frame: unknown) {
        if (typeof frame === "string") {
          sent.push(frame);
        }
      },
    } as unknown as GatewayWsClient["socket"],
    connect: {
      client: {
        id: opts.clientId ?? "openclaw-macos",
        version: opts.version ?? "1.0.0",
        platform: opts.platform ?? "darwin",
        mode: "node",
      },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    } as GatewayWsClient["connect"],
  };
}

describe("gateway/node-registry", () => {
  it("keeps a reconnected node when the old connection unregisters", async () => {
    const registry = new NodeRegistry();
    const oldFrames: string[] = [];
    const newClient = makeClient("conn-new", "node-1");

    registry.register(makeClient("conn-old", "node-1", oldFrames), {});
    const oldInvoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: 1_000,
    });
    const oldDisconnected = oldInvoke.catch((err: unknown) => err);
    const oldRequest = JSON.parse(oldFrames[0] ?? "{}") as { payload?: { id?: string } };
    const newSession = registry.register(newClient, {});

    expect(
      registry.handleInvokeResult({
        id: oldRequest.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-new",
        ok: true,
      }),
    ).toBe(false);
    expect(registry.unregister("conn-old")).toBeNull();
    expect(registry.get("node-1")).toBe(newSession);
    await expect(oldDisconnected).resolves.toBeInstanceOf(Error);
  });

  it("matches pending system.run events to the issuing connection", async () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(
      makeClient("conn-1", "node-1", frames, {
        clientId: "openclaw-node-host",
        platform: "linux",
      }),
      {},
    );
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-1", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "run-1",
        sessionKey: "agent:main:main",
        terminal: false,
      }),
    ).toBe(true);
    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-other",
        runId: "run-1",
        sessionKey: "agent:main:main",
        terminal: false,
      }),
    ).toBe(false);
    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "run-other",
        sessionKey: "agent:main:main",
        terminal: false,
      }),
    ).toBe(false);

    registry.handleInvokeResult({
      id: request.payload?.id ?? "",
      nodeId: "node-1",
      connId: "conn-1",
      ok: true,
    });
    await expect(invoke).resolves.toEqual({
      ok: true,
      payload: undefined,
      payloadJSON: null,
      error: null,
    });
    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "run-1",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(true);
    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "run-1",
        sessionKey: "agent:main:main",
        terminal: false,
      }),
    ).toBe(false);
  });

  it("keeps no-timeout system.run event authorization after invoke timeout", async () => {
    vi.useFakeTimers();
    const registry = new NodeRegistry();
    const frames: string[] = [];
    try {
      registry.register(makeClient("conn-1", "node-1", frames), {});
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "system.run",
        params: { runId: "run-timeout", sessionKey: "agent:main:main", timeoutMs: 0 },
        timeoutMs: 1,
      });

      await vi.advanceTimersByTimeAsync(1);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(
        registry.authorizeSystemRunEvent({
          nodeId: "node-1",
          connId: "conn-1",
          runId: "run-timeout",
          sessionKey: "agent:main:main",
          terminal: true,
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches a single system.run event when legacy payload omits runId", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-legacy", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects runId-less system.run events for non-legacy nodes", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(
      makeClient("conn-1", "node-1", frames, {
        clientId: "openclaw-node-host",
        platform: "linux",
      }),
      {},
    );
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-required", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(false);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("generates and forwards a runId when system.run params omit it", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { command: ["/bin/sh", "-lc", "printf ok"], sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });
    const request = JSON.parse(frames[0] ?? "{}") as {
      payload?: { paramsJSON?: string | null };
    };
    const forwarded = JSON.parse(request.payload?.paramsJSON ?? "{}") as { runId?: unknown };

    expect(typeof forwarded.runId).toBe("string");
    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: forwarded.runId as string,
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("clears system.run event authorization when invoke result fails", async () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-failed", sessionKey: "agent:main:main", timeoutMs: 0 },
      timeoutMs: 1_000,
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };

    expect(
      registry.handleInvokeResult({
        id: request.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-1",
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid params" },
      }),
    ).toBe(true);
    await expect(invoke).resolves.toEqual({
      ok: false,
      payload: undefined,
      payloadJSON: null,
      error: { code: "INVALID_REQUEST", message: "invalid params" },
    });
    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "run-failed",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(false);
  });

  it("matches legacy macOS exec events with runtime-generated runId when single pending run matches", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "gateway-run", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "legacy-runtime-run",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects mismatched runId fallback for non-macOS nodes", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(
      makeClient("conn-1", "node-1", frames, {
        clientId: "openclaw-node-host",
        platform: "linux",
      }),
      {},
    );
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "gateway-run", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "runtime-run",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(false);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("matches system.run events with emitted session key when invoke omitted sessionKey", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-without-session" },
      timeoutMs: 1_000,
    });

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        runId: "run-without-session",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects runId-less system.run events when the connection has multiple matches", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const first = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-a", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });
    const second = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { runId: "run-b", sessionKey: "agent:main:main" },
      timeoutMs: 1_000,
    });

    expect(
      registry.authorizeSystemRunEvent({
        nodeId: "node-1",
        connId: "conn-1",
        sessionKey: "agent:main:main",
        terminal: true,
      }),
    ).toBe(false);
    registry.unregister("conn-1");
    void first.catch(() => {});
    void second.catch(() => {});
  });

  it("sends raw event payload JSON without changing the envelope shape", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const payload = serializeEventPayload({ foo: "bar" });

    expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(true);
    expect(registry.sendEventRaw("missing-node", "chat", payload)).toBe(false);
    expect(registry.sendEventRaw("node-1", "heartbeat", null)).toBe(true);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        "not-json" as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        '{"x":1},"seq":999' as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);

    expect(frames).toEqual([
      '{"type":"event","event":"chat","payload":{"foo":"bar"}}',
      '{"type":"event","event":"heartbeat"}',
    ]);
  });
});

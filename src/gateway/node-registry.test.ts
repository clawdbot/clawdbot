import { EventEmitter } from "node:events";
import {
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(
  connId: string,
  nodeId: string,
  sent: string[] = [],
  opts: {
    clientId?: string;
    platform?: string;
    version?: string;
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    declaredCaps?: string[];
    declaredCommands?: string[];
    declaredPermissions?: Record<string, boolean>;
    socket?: GatewayWsClient["socket"];
  } = {},
): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket:
      opts.socket ??
      ({
        send(frame: unknown) {
          if (typeof frame === "string") {
            sent.push(frame);
          }
        },
      } as unknown as GatewayWsClient["socket"]),
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
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
      caps: opts.caps ?? [],
      commands: opts.commands ?? [],
      permissions: opts.permissions,
      declaredCaps: opts.declaredCaps,
      declaredCommands: opts.declaredCommands,
      declaredPermissions: opts.declaredPermissions,
    } as unknown as GatewayWsClient["connect"],
  };
}

function makeConnectivitySocket(emitPong: boolean) {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (frame: unknown) => void;
    ping: (data?: Buffer, mask?: boolean, cb?: (err?: Error) => void) => void;
  };
  socket.readyState = 1;
  socket.send = () => {};
  socket.ping = (_dataValue, _mask, cb) => {
    cb?.();
    if (emitPong) {
      queueMicrotask(() => socket.emit("pong"));
    }
  };
  return socket as unknown as GatewayWsClient["socket"];
}

function registerNode(registry: NodeRegistry, opts: Parameters<typeof makeClient>[3] = {}) {
  const frames: string[] = [];
  registry.register(makeClient("conn-1", "node-1", frames, opts), {});
  return frames;
}

function registerLinuxNode(registry: NodeRegistry) {
  return registerNode(registry, {
    clientId: "openclaw-node-host",
    platform: "linux",
  });
}

function invokeSystemRun(
  registry: NodeRegistry,
  frames: string[],
  params: Record<string, unknown>,
  timeoutMs = 1_000,
) {
  const invoke = registry.invoke({
    nodeId: "node-1",
    command: "system.run",
    params,
    timeoutMs,
  });
  const request = JSON.parse(frames[0] ?? "{}") as {
    payload?: { id?: string; paramsJSON?: string | null };
  };
  return { invoke, request };
}

type SystemRunEvent = Parameters<NodeRegistry["authorizeSystemRunEvent"]>[0];

function authorizeSystemRun(registry: NodeRegistry, overrides: Partial<SystemRunEvent> = {}) {
  return registry.authorizeSystemRunEvent({
    nodeId: "node-1",
    connId: "conn-1",
    sessionKey: "agent:main:main",
    terminal: true,
    ...overrides,
  });
}

describe("gateway/node-registry", () => {
  it("checks node websocket connectivity with ping/pong", async () => {
    const registry = new NodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        socket: makeConnectivitySocket(true),
      }),
      {},
    );

    await expect(registry.checkConnectivity("node-1", 50)).resolves.toEqual({ ok: true });
  });

  it("reports stale node websocket connectivity before invoke timeout", async () => {
    const registry = new NodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        socket: makeConnectivitySocket(false),
      }),
      {},
    );

    const result = await registry.checkConnectivity("node-1", 1);

    expect(result).toEqual({
      ok: false,
      error: { code: "TIMEOUT", message: "node connectivity probe timed out" },
    });
  });

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
    const frames = registerLinuxNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      runId: "run-1",
      sessionKey: "agent:main:main",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "run-1",
        terminal: false,
      }),
    ).toBe(true);
    expect(
      authorizeSystemRun(registry, {
        connId: "conn-other",
        runId: "run-1",
        terminal: false,
      }),
    ).toBe(false);
    expect(
      authorizeSystemRun(registry, {
        runId: "run-other",
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
      authorizeSystemRun(registry, {
        runId: "run-1",
        terminal: true,
      }),
    ).toBe(true);
    expect(
      authorizeSystemRun(registry, {
        runId: "run-1",
        terminal: false,
      }),
    ).toBe(false);
  });

  it("keeps no-timeout system.run event authorization after invoke timeout", async () => {
    vi.useFakeTimers();
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const { invoke } = invokeSystemRun(
        registry,
        frames,
        { runId: "run-timeout", sessionKey: "agent:main:main", timeoutMs: 0 },
        1,
      );

      await vi.advanceTimersByTimeAsync(1);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(
        authorizeSystemRun(registry, {
          runId: "run-timeout",
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized invoke and system.run authorization timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const { invoke } = invokeSystemRun(
        registry,
        frames,
        {
          runId: "run-oversized",
          sessionKey: "agent:main:main",
          timeoutMs: Number.MAX_SAFE_INTEGER,
        },
        Number.MAX_SAFE_INTEGER,
      );

      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });
      expect(
        authorizeSystemRun(registry, {
          runId: "run-oversized",
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires system.run authorization when the process clock is invalid", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-invalid-clock",
      sessionKey: "agent:main:main",
      timeoutMs: 1_000,
    });
    void invoke.catch(() => {});

    try {
      expect(
        authorizeSystemRun(registry, {
          runId: "run-invalid-clock",
        }),
      ).toBe(false);
    } finally {
      registry.unregister("conn-1");
      nowSpy.mockRestore();
    }
  });

  it("expires system.run authorization when the expiry would exceed the Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MAX_DATE_TIMESTAMP_MS);
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const { invoke } = invokeSystemRun(registry, frames, {
        runId: "run-overflow",
        sessionKey: "agent:main:main",
        timeoutMs: 1_000,
      });
      void invoke.catch(() => {});

      expect(
        authorizeSystemRun(registry, {
          runId: "run-overflow",
        }),
      ).toBe(false);
      registry.unregister("conn-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches a single system.run event when legacy payload omits runId", () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-legacy",
      sessionKey: "agent:main:main",
    });

    expect(authorizeSystemRun(registry)).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects runId-less system.run events for non-legacy nodes", () => {
    const registry = new NodeRegistry();
    const frames = registerLinuxNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-required",
      sessionKey: "agent:main:main",
    });

    expect(authorizeSystemRun(registry)).toBe(false);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("generates and forwards a runId when system.run params omit it", () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      command: ["/bin/sh", "-lc", "printf ok"],
      sessionKey: "agent:main:main",
    });
    const forwarded = JSON.parse(request.payload?.paramsJSON ?? "{}") as { runId?: unknown };

    expect(typeof forwarded.runId).toBe("string");
    expect(
      authorizeSystemRun(registry, {
        runId: forwarded.runId as string,
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("clears system.run event authorization when invoke result fails", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      runId: "run-failed",
      sessionKey: "agent:main:main",
      timeoutMs: 0,
    });

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
      authorizeSystemRun(registry, {
        runId: "run-failed",
      }),
    ).toBe(false);
  });

  it("matches legacy macOS exec events with runtime-generated runId when single pending run matches", () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "gateway-run",
      sessionKey: "agent:main:main",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "legacy-runtime-run",
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects mismatched runId fallback for non-macOS nodes", () => {
    const registry = new NodeRegistry();
    const frames = registerLinuxNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "gateway-run",
      sessionKey: "agent:main:main",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "runtime-run",
      }),
    ).toBe(false);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("matches system.run events with emitted session key when invoke omitted sessionKey", () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-without-session",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "run-without-session",
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects runId-less system.run events when the connection has multiple matches", () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const { invoke: first } = invokeSystemRun(registry, frames, {
      runId: "run-a",
      sessionKey: "agent:main:main",
    });
    const { invoke: second } = invokeSystemRun(registry, frames, {
      runId: "run-b",
      sessionKey: "agent:main:main",
    });

    expect(authorizeSystemRun(registry)).toBe(false);
    registry.unregister("conn-1");
    void first.catch(() => {});
    void second.catch(() => {});
  });

  it("sends raw event payload JSON without changing the envelope shape", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const payload = serializeEventPayload({ foo: "bar" });
    const nullPayload = serializeEventPayload(null);
    const falsePayload = serializeEventPayload(false);
    const zeroPayload = serializeEventPayload(0);
    const emptyStringPayload = serializeEventPayload("");

    expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "nullish", nullPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "flag", falsePayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "count", zeroPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "empty", emptyStringPayload)).toBe(true);
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
      '{"type":"event","event":"nullish","payload":null}',
      '{"type":"event","event":"flag","payload":false}',
      '{"type":"event","event":"count","payload":0}',
      '{"type":"event","event":"empty","payload":""}',
      '{"type":"event","event":"heartbeat"}',
    ]);
  });

  it("rejects raw event sends when the node socket buffer is saturated", () => {
    resetDiagnosticEventsForTest();
    const diagnosticEvents: unknown[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => diagnosticEvents.push(event));
    const registry = new NodeRegistry();
    const socket = {
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    registry.register(
      makeClient("conn-1", "node-1", [], {
        socket: socket as unknown as GatewayWsClient["socket"],
      }),
      {},
    );
    const payload = serializeEventPayload({ foo: "bar" });

    try {
      expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
      expect(diagnosticEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "payload.large",
            action: "rejected",
            surface: "gateway.ws.outbound_buffer",
            bytes: MAX_BUFFERED_BYTES + 1,
            limitBytes: MAX_BUFFERED_BYTES,
            reason: "ws_send_buffer_close",
          }),
        ]),
      );
    } finally {
      stopDiagnostics();
      resetDiagnosticEventsForTest();
    }
  });

  it("refreshes effective live surface within the declared surface", () => {
    const registry = new NodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      caps: [],
      commands: [],
      declaredCaps: ["talk"],
      declaredCommands: ["talk.ptt.start"],
      declaredPermissions: { microphone: true, camera: false },
    });

    const session = registry.register(client, {});
    expect(session.caps).toEqual([]);
    expect(session.commands).toEqual([]);

    const updated = registry.updateSurface("node-1", {
      caps: ["talk", "screen"],
      commands: ["talk.ptt.start", "system.run"],
      permissions: { microphone: true, camera: true },
    });

    expect(updated?.caps).toEqual(["talk"]);
    expect(updated?.commands).toEqual(["talk.ptt.start"]);
    expect(updated?.permissions).toEqual({ microphone: true, camera: false });
    expect(client.connect.caps).toEqual(["talk"]);
    expect((client.connect as { commands?: string[] }).commands).toEqual(["talk.ptt.start"]);
  });

  it("clears effective permissions when explicitly removed", () => {
    const registry = new NodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      permissions: { camera: false },
      declaredPermissions: { camera: false },
    });

    registry.register(client, {});
    const updated = registry.updateSurface("node-1", {
      caps: [],
      commands: [],
      permissions: undefined,
    });

    expect(updated?.permissions).toBeUndefined();
    expect(
      (client.connect as { permissions?: Record<string, boolean> }).permissions,
    ).toBeUndefined();
  });
});

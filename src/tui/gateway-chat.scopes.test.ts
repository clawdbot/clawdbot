// Covers TUI device pairing and operator scope upgrades through the real Gateway client.
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { deriveDeviceIdFromPublicKey } from "../infra/device-identity.js";
import type { GatewayChatClient } from "./gateway-chat.js";

type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: {
    client?: { id?: string };
    role?: string;
    scopes?: string[];
    auth?: { token?: string; deviceToken?: string };
    device?: { id?: string; nonce?: string; signature?: string };
    [key: string]: unknown;
  };
};

describe("GatewayChatClient operator scopes", () => {
  it("requests and completes an approved TUI scope upgrade through the real Gateway client", async () => {
    const requestedScopes = [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
    ];
    const sharedGatewayToken = "test-shared-gateway-token";
    let cachedDeviceAuth = {
      token: "cached-read-only-device-token",
      scopes: ["operator.read"],
    };
    const loadDeviceAuthToken = vi.fn(() => cachedDeviceAuth);
    const storeDeviceAuthToken = vi.fn((record: { token: string; scopes: string[] }) => {
      cachedDeviceAuth = { token: record.token, scopes: [...record.scopes] };
    });
    const clearDeviceAuthToken = vi.fn();
    const sockets: ScopeUpgradeWebSocket[] = [];
    const clients: GatewayChatClient[] = [];
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const deviceId = deriveDeviceIdFromPublicKey(publicKeyPem);
    if (!deviceId) {
      throw new Error("expected a valid isolated TUI device identity");
    }
    const deviceIdentity = {
      deviceId,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem,
    };

    class ScopeUpgradeWebSocket extends EventEmitter {
      static readonly OPEN = 1;
      readyState = 0;
      readonly sent: GatewayRequestFrame[] = [];

      constructor(_url: string, _options?: unknown) {
        super();
        sockets.push(this);
      }

      send(data: string): void {
        this.sent.push(JSON.parse(data) as GatewayRequestFrame);
      }

      close(code = 1000, reason = ""): void {
        this.readyState = 3;
        this.emit("close", code, Buffer.from(reason));
      }

      terminate(): void {
        this.close();
      }

      open(): void {
        this.readyState = ScopeUpgradeWebSocket.OPEN;
        this.emit("open");
      }

      receive(frame: unknown): void {
        this.emit("message", JSON.stringify(frame));
      }
    }

    vi.resetModules();
    vi.doMock("ws", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ws")>();
      return { ...actual, WebSocket: ScopeUpgradeWebSocket };
    });
    vi.doMock("../gateway/client.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../gateway/client.js")>();
      class IsolatedGatewayClient extends actual.GatewayClient {
        constructor(options: ConstructorParameters<typeof actual.GatewayClient>[0]) {
          super({
            ...options,
            hostDeps: {
              ...options.hostDeps,
              loadOrCreateDeviceIdentity: () => deviceIdentity,
              loadDeviceAuthToken,
              storeDeviceAuthToken,
              clearDeviceAuthToken,
              beforeConnect: () => {},
              registerGatewayLoopbackBypass: () => undefined,
              logDebug: () => {},
              logError: () => {},
              redactForLog: (message) => message,
            },
          });
        }
      }
      return { ...actual, GatewayClient: IsolatedGatewayClient };
    });

    try {
      const { GatewayChatClient: RealGatewayChatClient } = await import("./gateway-chat.js");
      const openConnection = async (token?: string) => {
        const client = new RealGatewayChatClient({
          url: "ws://127.0.0.1:18789",
          ...(token ? { token } : {}),
        });
        clients.push(client);
        const socketCount = sockets.length;
        client.start();
        await vi.waitFor(() => expect(sockets).toHaveLength(socketCount + 1));
        const socket = sockets.at(-1);
        if (!socket) {
          throw new Error("expected isolated TUI WebSocket");
        }
        socket.open();
        const nonce = `tui-scope-upgrade-${socketCount}`;
        socket.receive({
          type: "event",
          event: "connect.challenge",
          payload: { nonce, ts: Date.now() },
        });
        const connect = socket.sent.find((frame) => frame.method === "connect");
        if (!connect) {
          throw new Error("expected real TUI Gateway connect frame");
        }
        expect(connect.params).toMatchObject({
          client: { id: "openclaw-tui" },
          role: "operator",
          scopes: requestedScopes,
          device: { id: deviceIdentity.deviceId, nonce },
        });
        expect(connect.params?.auth).toEqual(
          token ? { token } : { deviceToken: cachedDeviceAuth.token },
        );
        expect(connect.params?.device?.signature).toEqual(expect.any(String));
        return { client, socket, connect };
      };

      const readOnly = await openConnection();
      const onReadOnlyDisconnected = vi.fn();
      readOnly.client.onDisconnected = onReadOnlyDisconnected;
      readOnly.socket.receive({
        type: "res",
        id: readOnly.connect.id,
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "device token scope mismatch",
          details: {
            code: ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH,
            authReason: "scope_mismatch",
          },
        },
      });
      await vi.waitFor(() => expect(onReadOnlyDisconnected).toHaveBeenCalledWith("connect failed"));
      expect(cachedDeviceAuth.scopes).toEqual(["operator.read"]);
      expect(storeDeviceAuthToken).not.toHaveBeenCalled();
      expect(clearDeviceAuthToken).not.toHaveBeenCalled();
      await readOnly.client.stop();

      const rejected = await openConnection(sharedGatewayToken);
      const onDisconnected = vi.fn();
      rejected.client.onDisconnected = onDisconnected;
      rejected.socket.receive({
        type: "res",
        id: rejected.connect.id,
        ok: false,
        error: {
          code: ErrorCodes.NOT_PAIRED,
          message: "pairing required",
          details: {
            code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
            reason: "scope-upgrade",
            requestId: "tui-scope-upgrade-request",
            requestedRole: "operator",
            requestedScopes,
            approvedScopes: ["operator.read"],
          },
        },
      });
      await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalledWith("connect failed"));
      expect(cachedDeviceAuth.scopes).toEqual(["operator.read"]);
      expect(storeDeviceAuthToken).not.toHaveBeenCalled();
      expect(clearDeviceAuthToken).not.toHaveBeenCalled();
      await expect(
        rejected.client.sendChat({ sessionKey: "main", message: "not yet approved" }),
      ).rejects.toThrow("gateway not connected");
      await rejected.client.stop();

      const approved = await openConnection(sharedGatewayToken);
      approved.socket.receive({
        type: "res",
        id: approved.connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          features: { methods: ["chat.history", "chat.send"], events: [] },
          auth: {
            role: "operator",
            scopes: requestedScopes,
            deviceToken: "approved-tui-device-token",
          },
        },
      });
      await approved.client.waitForReady();
      expect(storeDeviceAuthToken).toHaveBeenCalledWith({
        deviceId: deviceIdentity.deviceId,
        role: "operator",
        token: "approved-tui-device-token",
        scopes: requestedScopes,
        env: undefined,
      });

      const history = approved.client.loadHistory({ sessionKey: "main", limit: 20 });
      const historyRequest = approved.socket.sent.find((frame) => frame.method === "chat.history");
      expect(historyRequest?.params).toMatchObject({ sessionKey: "main", limit: 20 });
      approved.socket.receive({
        type: "res",
        id: historyRequest?.id,
        ok: true,
        payload: { messages: [] },
      });
      await expect(history).resolves.toEqual({ messages: [] });

      const chat = approved.client.sendChat({
        sessionKey: "main",
        message: "approved chat message",
        runId: "tui-scope-upgrade-run",
      });
      const chatRequest = approved.socket.sent.find((frame) => frame.method === "chat.send");
      expect(chatRequest?.params).toMatchObject({
        sessionKey: "main",
        message: "approved chat message",
        idempotencyKey: "tui-scope-upgrade-run",
      });
      approved.socket.receive({
        type: "res",
        id: chatRequest?.id,
        ok: true,
        payload: { runId: "tui-scope-upgrade-run", status: "started" },
      });
      await expect(chat).resolves.toEqual({
        runId: "tui-scope-upgrade-run",
        status: "started",
      });
    } finally {
      await Promise.all(clients.map((client) => client.stop()));
      vi.doUnmock("ws");
      vi.doUnmock("../gateway/client.js");
      vi.resetModules();
    }
  });
});

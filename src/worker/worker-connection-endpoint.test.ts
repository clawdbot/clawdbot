import { describe, expect, it, vi } from "vitest";
import type { CertMeta, WebSocket } from "ws";
import { GatewayClient } from "../gateway/client.js";
import {
  parseWorkerConnectionEndpoint,
  resolveWorkerConnectionTarget,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const wsMockState = vi.hoisted(() => ({ options: undefined as ClientSocketOptions | undefined }));

type ClientSocketOptions = {
  checkServerIdentity?: (hostname: string, cert: CertMeta) => Error | undefined;
};

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return {
    ...actual,
    WebSocket: class MockWebSocket {
      on = vi.fn();
      close = vi.fn();
      send = vi.fn();

      constructor(_url: unknown, options: ClientSocketOptions) {
        wsMockState.options = options;
      }
    },
  };
});

function getClientSocketOptions(): ClientSocketOptions | undefined {
  return wsMockState.options;
}

describe("worker connection endpoint", () => {
  it("resolves Unix sockets through the existing ws+unix carrier", () => {
    const endpoint = parseWorkerConnectionEndpoint({
      kind: "unix",
      socketPath: "/tmp/openclaw-worker/gateway.sock",
    });
    expect(endpoint).toBeDefined();

    expect(resolveWorkerConnectionTarget(endpoint!)).toMatchObject({
      url: "ws+unix:///tmp/openclaw-worker/gateway.sock:/",
      options: {},
    });
  });

  it("applies the canonical TLS pin policy to public worker URLs", () => {
    const fingerprint = "ab".repeat(32);
    const endpoint = parseWorkerConnectionEndpoint({
      kind: "websocket",
      url: "wss://gateway.example/tenant/__openclaw__/worker",
      tlsFingerprint: fingerprint,
    });
    expect(endpoint).toBeDefined();

    const target = resolveWorkerConnectionTarget(endpoint!);
    expect(target.options.headers).toBeUndefined();
    const checkServerIdentity = (hostname: string, cert: CertMeta) =>
      target.options.checkServerIdentity?.(hostname, cert);
    expect(target.options.rejectUnauthorized).toBe(false);
    expect(
      checkServerIdentity("gateway.example", {
        fingerprint256: fingerprint,
      } as unknown as CertMeta),
    ).toBeUndefined();
    expect(
      checkServerIdentity("gateway.example", {
        fingerprint256: "cd".repeat(32),
      } as unknown as CertMeta),
    ).toEqual(new Error("Server TLS fingerprint mismatch"));

    const socket = {
      _socket: { getPeerCertificate: () => ({ fingerprint256: fingerprint }) },
    } as unknown as WebSocket;
    expect(target.validateSocket(socket)).toBeNull();
  });

  it("keeps node-host and worker TLS pin forms in parity", () => {
    const fingerprint = "ab".repeat(32);
    const presentedFingerprint = (fingerprint.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();
    const certificate = { fingerprint256: presentedFingerprint } as unknown as CertMeta;
    const acceptedPins = [
      `sha256:${fingerprint.toUpperCase()}`,
      fingerprint.toUpperCase(),
      presentedFingerprint,
      `ShA256:${presentedFingerprint}`,
    ];

    for (const tlsFingerprint of acceptedPins) {
      wsMockState.options = undefined;
      new GatewayClient({ url: "wss://gateway.example.com", tlsFingerprint }).start();
      const nodeHostOptions = getClientSocketOptions();
      const workerEndpoint = parseWorkerConnectionEndpoint({
        kind: "websocket",
        url: "wss://gateway.example.com/__openclaw__/worker",
        tlsFingerprint,
      });
      expect(workerEndpoint).toMatchObject({ tlsFingerprint: fingerprint });
      const worker = resolveWorkerConnectionTarget(workerEndpoint!);
      const socket = {
        _socket: { getPeerCertificate: () => ({ fingerprint256: presentedFingerprint }) },
      } as unknown as WebSocket;

      expect(
        nodeHostOptions?.checkServerIdentity?.("gateway.example.com", certificate),
      ).toBeUndefined();
      expect(
        worker.options.checkServerIdentity?.("gateway.example.com", certificate),
      ).toBeUndefined();
      expect(worker.validateSocket(socket)).toBeNull();
    }

    const wrongPin = "cd".repeat(32);
    wsMockState.options = undefined;
    new GatewayClient({ url: "wss://gateway.example.com", tlsFingerprint: wrongPin }).start();
    const nodeHostOptions = getClientSocketOptions();
    const worker = resolveWorkerConnectionTarget({
      kind: "websocket",
      url: "wss://gateway.example.com/__openclaw__/worker",
      tlsFingerprint: wrongPin,
    });

    expect(nodeHostOptions?.checkServerIdentity?.("gateway.example.com", certificate)).toEqual(
      new Error("Server TLS fingerprint mismatch"),
    );
    expect(worker.options.checkServerIdentity?.("gateway.example.com", certificate)).toEqual(
      new Error("Server TLS fingerprint mismatch"),
    );
    const socket = {
      _socket: { getPeerCertificate: () => ({ fingerprint256: presentedFingerprint }) },
    } as unknown as WebSocket;
    expect(worker.validateSocket(socket)).toEqual(new Error("gateway tls fingerprint mismatch"));
  });

  it("carries the closed Cloudflare Access credential pair to the worker upgrade", () => {
    const clientId = ["cf", "worker", "id"].join("-");
    const clientSecret = ["cf", "worker", "secret"].join("-");
    const endpoint = parseWorkerConnectionEndpoint({
      kind: "websocket",
      url: "wss://gateway.example/__openclaw__/worker",
      cloudflareAccess: { clientId, clientSecret },
    });

    expect(endpoint).toBeDefined();
    expect(resolveWorkerConnectionTarget(endpoint!).options.headers).toEqual({
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    });
  });

  it("rejects public plaintext while retaining the private-network break-glass", () => {
    const endpoint = {
      kind: "websocket" as const,
      url: "ws://gateway.example/__openclaw__/worker",
    };
    expect(() => resolveWorkerConnectionTarget(endpoint, {})).toThrow("SECURITY ERROR");
    expect(() =>
      resolveWorkerConnectionTarget(endpoint, { OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" }),
    ).not.toThrow();
  });

  it("rejects Access credentials on plaintext worker endpoints", () => {
    const endpoint = {
      kind: "websocket" as const,
      url: "ws://127.0.0.1/__openclaw__/worker",
      cloudflareAccess: {
        clientId: "cf-worker-plaintext-id",
        clientSecret: "cf-worker-plaintext-secret",
      },
    };

    expect(parseWorkerConnectionEndpoint(endpoint)).toBeUndefined();
    expect(() => resolveWorkerConnectionTarget(endpoint as WorkerConnectionEndpoint)).toThrow(
      "Cloudflare Access credentials require a wss:// worker endpoint",
    );
  });
});

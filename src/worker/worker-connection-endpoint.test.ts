import { describe, expect, it } from "vitest";
import type { CertMeta, WebSocket } from "ws";
import {
  parseWorkerConnectionEndpoint,
  resolveWorkerConnectionTarget,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

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

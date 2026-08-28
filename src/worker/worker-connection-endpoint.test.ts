import { describe, expect, it } from "vitest";
import {
  parseWorkerConnectionEndpoint,
  resolveWorkerConnectionTarget,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const fingerprint = "ab".repeat(32);
const colonFingerprint = (fingerprint.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();

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

  it.each([
    `sha256:${fingerprint.toUpperCase()}`,
    fingerprint.toUpperCase(),
    colonFingerprint,
    `ShA256:${colonFingerprint}`,
  ])("normalizes the worker TLS pin %s", (tlsFingerprint) => {
    const endpoint = parseWorkerConnectionEndpoint({
      kind: "websocket",
      url: "wss://gateway.example/tenant/__openclaw__/worker",
      tlsFingerprint,
    });
    expect(endpoint).toMatchObject({ tlsFingerprint: fingerprint });
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

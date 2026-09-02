import { describe, expect, it } from "vitest";
import {
  parseWorkerConnectionEndpoint,
  resolveWorkerConnectionTarget,
  WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const fingerprint = "ab".repeat(32);
const colonFingerprint = (fingerprint.match(/.{2}/gu)?.join(":") ?? "").toUpperCase();

describe("worker connection endpoint", () => {
  it.each([
    { name: "control", char: "\0" },
    { name: "quote", char: '"' },
    { name: "backslash", char: "\\" },
    { name: "newline", char: "\n" },
    { name: "lone surrogate", char: "\ud800" },
    { name: "Unicode", char: "漢" },
    { name: "astral Unicode", char: "😀" },
  ])("bounds maximal $name endpoint and Access fields", ({ char }) => {
    const prefix = "wss://worker.invalid/";
    const suffix = "/__openclaw__/worker";
    const fill = (length: number) => char.repeat(Math.ceil(length / char.length)).slice(0, length);
    const input = {
      kind: "websocket",
      url: prefix + fill(4_096 - prefix.length - suffix.length) + suffix,
      tlsFingerprint: colonFingerprint,
      cloudflareAccess: { clientId: `x${fill(4_095)}`, clientSecret: `s${fill(4_095)}` },
    };
    const parsed = parseWorkerConnectionEndpoint(input);
    expect(parsed).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(
      WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES,
    );
    for (const candidate of [
      { ...input, url: prefix + "x" + input.url.slice(prefix.length) },
      {
        ...input,
        cloudflareAccess: {
          ...input.cloudflareAccess,
          clientId: `${input.cloudflareAccess.clientId}x`,
        },
      },
      {
        ...input,
        cloudflareAccess: {
          ...input.cloudflareAccess,
          clientSecret: `${input.cloudflareAccess.clientSecret}x`,
        },
      },
    ]) {
      expect(parseWorkerConnectionEndpoint(candidate)).toBeUndefined();
    }
    const unix = parseWorkerConnectionEndpoint({ kind: "unix", socketPath: `/${fill(255)}` });
    expect(unix).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(unix))).toBeLessThanOrEqual(
      WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES,
    );
  });

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

  it("rejects endpoint fields inherited from the prototype", () => {
    const endpoint = Object.assign(Object.create({ kind: "unix" }) as Record<string, unknown>, {
      socketPath: "/tmp/openclaw-worker/gateway.sock",
    });

    expect(parseWorkerConnectionEndpoint(endpoint)).toBeUndefined();

    const websocketEndpoint = Object.assign(Object.create({ tlsFingerprint: fingerprint }), {
      kind: "websocket",
      url: "wss://gateway.example/__openclaw__/worker",
    });

    expect(parseWorkerConnectionEndpoint(websocketEndpoint)).toBeUndefined();
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

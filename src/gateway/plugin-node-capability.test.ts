import { describe, expect, test } from "vitest";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  hasAuthorizedPluginNodeCapability,
  indexPluginNodeCapabilitySurfaces,
  normalizePluginNodeCapabilityScopedUrl,
  refreshClientPluginNodeCapability,
  replacePluginNodeCapabilityInScopedHostUrl,
  setClientPluginNodeCapability,
} from "./plugin-node-capability.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(
  overrides: Partial<GatewayWsClient> & {
    pluginNodeCapabilities?: GatewayWsClient["pluginNodeCapabilities"];
  } = {},
): GatewayWsClient {
  return {
    socket: {} as GatewayWsClient["socket"],
    connect: {
      role: "node",
      client: {
        mode: "node",
      },
    } as GatewayWsClient["connect"],
    connId: "node-1",
    usesSharedGatewayAuth: false,
    ...overrides,
  };
}

describe("plugin node capability helpers", () => {
  test("builds scoped host urls from clean base urls", () => {
    expect(
      buildPluginNodeCapabilityScopedHostUrl(
        "http://127.0.0.1:18789/root/?debug=1#hash",
        "token value",
      ),
    ).toBe("http://127.0.0.1:18789/root/__openclaw__/cap/token%20value");
    expect(buildPluginNodeCapabilityScopedHostUrl("not a url", "token")).toBeUndefined();
    expect(buildPluginNodeCapabilityScopedHostUrl("http://127.0.0.1:18789", " ")).toBeUndefined();
  });

  test("normalizes scoped urls and moves capability into the query string", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl(
      "/__openclaw__/cap/token%20value/__openclaw__/canvas/file.txt?download=1",
    );
    expect(normalized).toEqual({
      pathname: "/__openclaw__/canvas/file.txt",
      capability: "token value",
      rewrittenUrl: "/__openclaw__/canvas/file.txt?download=1&oc_cap=token+value",
      scopedPath: true,
      malformedScopedPath: false,
    });
  });

  test("replaces scoped capability tokens without nesting capability prefixes", () => {
    expect(
      replacePluginNodeCapabilityInScopedHostUrl(
        "http://127.0.0.1:18789/__openclaw__/cap/old-token/__openclaw__/a2ui/",
        "new token",
      ),
    ).toBe("http://127.0.0.1:18789/__openclaw__/cap/new%20token/__openclaw__/a2ui");
  });

  test("marks malformed scoped urls without authorizing a path capability", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl("/__openclaw__/cap/broken");
    expect(normalized.scopedPath).toBe(true);
    expect(normalized.malformedScopedPath).toBe(true);
    expect(normalized.capability).toBeUndefined();
    expect(normalized.rewrittenUrl).toBeUndefined();
  });

  test("stores capabilities per plugin surface", () => {
    const client = makeClient();
    setClientPluginNodeCapability({
      client,
      surface: { surface: "canvas" },
      capability: "canvas-token",
      expiresAtMs: 100,
    });
    setClientPluginNodeCapability({
      client,
      surface: { surface: "files" },
      capability: "files-token",
      expiresAtMs: 200,
    });
    expect(client.pluginNodeCapabilities).toEqual({
      canvas: { capability: "canvas-token", expiresAtMs: 100 },
      files: { capability: "files-token", expiresAtMs: 200 },
    });
  });

  test("stores capabilities per plugin-owned surface scope", () => {
    const client = makeClient();
    setClientPluginNodeCapability({
      client,
      surface: { surface: "canvas", scopeKey: "canvas-plugin:canvas" },
      capability: "canvas-token",
      expiresAtMs: 100,
    });
    setClientPluginNodeCapability({
      client,
      surface: { surface: "canvas", scopeKey: "other-plugin:canvas" },
      capability: "other-token",
      expiresAtMs: 200,
    });

    expect(client.pluginNodeCapabilities).toEqual({
      "canvas\u0000canvas-plugin:canvas": { capability: "canvas-token", expiresAtMs: 100 },
      "canvas\u0000other-plugin:canvas": { capability: "other-token", expiresAtMs: 200 },
    });
  });

  test("indexes plugin capability surfaces with shortest ttl per surface", () => {
    expect(
      indexPluginNodeCapabilitySurfaces([
        { surface: "canvas", ttlMs: 5_000 },
        { surface: " canvas ", ttlMs: 100 },
        { surface: "files" },
      ]),
    ).toEqual({
      canvas: { surface: "canvas", ttlMs: 100 },
      files: { surface: "files" },
    });
  });

  test("refreshes client plugin surface url and stored capability", () => {
    const client = makeClient({
      pluginSurfaceUrls: {
        canvas: "http://127.0.0.1:18789/__openclaw__/cap/old-token",
      },
      pluginNodeCapabilitySurfaces: {
        canvas: { surface: "canvas", ttlMs: 100 },
      },
    });
    const refreshed = refreshClientPluginNodeCapability({
      client,
      surface: { surface: "canvas" },
      nowMs: 1_000,
    });
    expect(refreshed?.surface).toBe("canvas");
    expect(refreshed?.expiresAtMs).toBe(1_100);
    expect(refreshed?.capability).toBeTypeOf("string");
    expect(refreshed?.capability).not.toBe("");
    expect(refreshed?.scopedUrl).toContain("/__openclaw__/cap/");
    expect(refreshed?.scopedUrl).not.toContain("old-token/__openclaw__/cap/");
    expect(client.pluginSurfaceUrls?.canvas).toBe(refreshed?.scopedUrl);
    expect(client.pluginNodeCapabilities?.canvas).toEqual({
      capability: refreshed?.capability,
      expiresAtMs: 1_100,
    });
  });

  test("authorizes matching plugin surface capabilities and slides expiry", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });
    const clients = new Set([client]);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_100);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas" },
        capability: "wrong",
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "files" },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  test("does not authorize the same surface token for a different plugin scope", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        "canvas\u0000canvas-plugin:canvas": { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });
    const clients = new Set([client]);

    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas", scopeKey: "other-plugin:canvas" },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas", scopeKey: "canvas-plugin:canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  test("rejects expired capabilities", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 999 },
      },
    });
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas" },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
  });
});

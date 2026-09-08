// Plugin node capability tests cover scoped host URLs, request rewriting, and
// authorization state attached to gateway node clients.
import { describe, expect, test, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  hasAuthorizedClientPluginNodeCapabilityUrl,
  hasAuthorizedPluginNodeCapability,
  indexPluginNodeCapabilitySurfaces,
  normalizePluginNodeCapabilityScopedUrl,
  pluginNodeCapabilityScopedHostUrlsConflict,
  reconcileClientPluginNodeCapabilities,
  refreshClientPluginNodeCapability,
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
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
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

  test("detects conflicting scoped host capabilities across rewritten hosts", () => {
    expect(
      pluginNodeCapabilityScopedHostUrlsConflict(
        "http://127.0.0.1:18789/__openclaw__/cap/token%20value",
        "https://gateway.example:7443/__openclaw__/cap/token%20value",
      ),
    ).toBe(false);
    expect(
      pluginNodeCapabilityScopedHostUrlsConflict(
        "https://gateway.example/__openclaw__/cap/old-token",
        "https://gateway.example/__openclaw__/cap/new-token",
      ),
    ).toBe(true);
    expect(pluginNodeCapabilityScopedHostUrlsConflict("not-a-url", "also-not-a-url")).toBe(false);
  });

  test("validates a current scoped URL without extending its authorization", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "current-token", expiresAtMs: 1_500 },
      },
    });
    const params = {
      client,
      surface: { surface: "canvas" },
      url: "https://gateway.example/__openclaw__/cap/current-token",
      nowMs: 1_000,
    };

    expect(hasAuthorizedClientPluginNodeCapabilityUrl(params)).toBe(true);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        ...params,
        url: "https://gateway.example/__openclaw__/cap/other-token",
      }),
    ).toBe(false);
    expect(hasAuthorizedClientPluginNodeCapabilityUrl({ ...params, nowMs: 1_500 })).toBe(false);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        ...params,
        client: makeClient(),
      }),
    ).toBe(false);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        ...params,
        surface: { surface: "canvas", scopeKey: "other-plugin:canvas" },
      }),
    ).toBe(false);
  });

  test("treats the scoped path capability as authoritative over a stale query", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl(
      "/__openclaw__/cap/current-token/__openclaw__/canvas/?oc_cap=stale-token",
    );
    expect(normalized).toEqual({
      pathname: "/__openclaw__/canvas/",
      capability: "current-token",
      rewrittenUrl: "/__openclaw__/canvas/?oc_cap=current-token",
      scopedPath: true,
      malformedScopedPath: false,
    });
  });

  test("marks malformed scoped urls without authorizing a path capability", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl("/__openclaw__/cap/broken");
    expect(normalized.scopedPath).toBe(true);
    expect(normalized.malformedScopedPath).toBe(true);
    expect(normalized.capability).toBeUndefined();
    expect(normalized.rewrittenUrl).toBeUndefined();
  });

  test("marks malformed request targets without throwing", () => {
    for (const rawUrl of ["//", "///", "//${jndi:ldap://example}.action"]) {
      const normalized = normalizePluginNodeCapabilityScopedUrl(rawUrl);
      expect(normalized).toMatchObject({
        pathname: "/",
        scopedPath: false,
        malformedScopedPath: true,
      });
      expect(normalized.capability).toBeUndefined();
      expect(normalized.rewrittenUrl).toBeUndefined();
    }
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

  test.each([
    { change: "enabled", before: [], after: [{ surface: "files" }] },
    { change: "disabled", before: [{ surface: "files" }], after: [] },
    {
      change: "owner changed",
      before: [{ surface: "files", scopeKey: "previous:files" }],
      after: [{ surface: "files", scopeKey: "current:files" }],
    },
  ])("reconnects nodes when a capability is $change", ({ before, after }) => {
    const close = vi.fn();
    const client = makeClient({
      connect: { ...makeClient().connect, caps: ["files"] },
      pluginNodeCapabilitySurfaces: indexPluginNodeCapabilitySurfaces(before),
    });

    expect(
      reconcileClientPluginNodeCapabilities(
        client,
        indexPluginNodeCapabilitySurfaces(after),
        close,
      ),
    ).toBe(false);
    expect(client).toMatchObject({
      invalidated: true,
      invalidatedReason: "plugin-node-capabilities-changed",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(client.pluginSurfaceUrls).toBeUndefined();
  });

  test.each([
    { node: "browser-only", caps: ["browser"], maxProtocol: PROTOCOL_VERSION },
    { node: "without approved capabilities", caps: [], maxProtocol: PROTOCOL_VERSION },
  ])("preserves $node nodes across unrelated hosted-surface changes", ({ caps, maxProtocol }) => {
    const close = vi.fn();
    const client = makeClient({
      connect: { ...makeClient().connect, minProtocol: maxProtocol, maxProtocol, caps },
    });
    for (const next of [
      [{ surface: "files", scopeKey: "previous:files", ttlMs: 100 }],
      [{ surface: "files", scopeKey: "current:files", ttlMs: 200 }],
      [],
    ]) {
      const surfaces = indexPluginNodeCapabilitySurfaces(next);
      expect(reconcileClientPluginNodeCapabilities(client, surfaces, close)).toBe(true);
      expect(client.invalidated).toBeUndefined();
      expect(close).not.toHaveBeenCalled();
      expect(
        refreshClientPluginNodeCapability({ client, surface: { surface: "files" } }),
      ).toBeUndefined();
      client.pluginNodeCapabilitySurfaces = surfaces;
    }
  });

  test("reconnects legacy nodes to recompute session protocol ceilings", () => {
    const close = vi.fn();
    const client = makeClient({
      connect: {
        ...makeClient().connect,
        minProtocol: PROTOCOL_VERSION - 1,
        maxProtocol: PROTOCOL_VERSION - 1,
        caps: [],
      },
    });
    expect(
      reconcileClientPluginNodeCapabilities(client, { files: { surface: "files" } }, close),
    ).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  test("revokes changed node capabilities while preserving current nodes and operators", () => {
    const surface = { surface: "files", scopeKey: "publisher:files", ttlMs: 200 };
    const surfaces = indexPluginNodeCapabilitySurfaces([surface]);
    const close = vi.fn();
    const changed = makeClient({
      connect: { ...makeClient().connect, caps: [] },
      pluginSurfaceUrls: { files: "https://gateway.example/__openclaw__/cap/current-token" },
      pluginNodeCapabilitySurfaces: { files: { ...surface, ttlMs: 100 } },
      pluginNodeCapabilities: {
        "files\0publisher:files": { capability: "current-token", expiresAtMs: 2_000 },
      },
    });
    changed.socket.close = close;
    const current = makeClient({ pluginNodeCapabilitySurfaces: surfaces });
    const operator = makeClient({ connect: { ...current.connect, role: "operator" } });

    expect(reconcileClientPluginNodeCapabilities(changed, surfaces)).toBe(false);
    expect(reconcileClientPluginNodeCapabilities(current, surfaces)).toBe(true);
    expect(reconcileClientPluginNodeCapabilities(operator, surfaces)).toBe(true);
    expect(close).toHaveBeenCalledExactlyOnceWith(1012, "node capabilities changed");
    expect(current.invalidated).toBeUndefined();
    expect(operator.invalidated).toBeUndefined();
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: [changed],
        surface,
        capability: "current-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
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

  test("does not refresh client plugin capabilities when the clock is invalid", () => {
    const client = makeClient({
      pluginSurfaceUrls: {
        canvas: "http://127.0.0.1:18789/__openclaw__/cap/old-token",
      },
      pluginNodeCapabilitySurfaces: {
        canvas: { surface: "canvas", ttlMs: 100 },
      },
    });

    expect(
      refreshClientPluginNodeCapability({
        client,
        surface: { surface: "canvas" },
        nowMs: Number.NaN,
      }),
    ).toBeUndefined();
    expect(client.pluginSurfaceUrls?.canvas).toBe(
      "http://127.0.0.1:18789/__openclaw__/cap/old-token",
    );
    expect(client.pluginNodeCapabilities).toBeUndefined();
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

  test("rejects invalidated clients without sliding capability expiry", () => {
    const client = makeClient({
      invalidated: true,
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });

    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
  });

  test("rejects plugin surface capabilities when the clock is invalid", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: Number.NaN,
      }),
    ).toBe(false);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
  });

  test("rejects plugin surface capabilities with invalid stored expiries", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: Number.POSITIVE_INFINITY },
      },
    });
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas", ttlMs: 100 },
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

// Codex tests cover plugin app cache key plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCodexPluginAppCacheEndpoint", () => {
  it("keys plugin app inventory by initialized remote runtime identity", () => {
    const base = {
      appServer: {
        start: {
          transport: "websocket" as const,
          command: "codex",
          args: [],
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "secret-token",
          headers: {},
        },
      },
      authProfileId: "profile-1",
    };

    const first = buildCodexPluginAppCacheKey({
      ...base,
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/home/oai/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const second = buildCodexPluginAppCacheKey({
      ...base,
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/Users/kevinlin/.codex",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-token");
    expect(second).not.toContain("secret-token");
  });

  it("fingerprints the remote app-server runtime used by thread bindings", () => {
    const first = buildCodexAppServerRuntimeFingerprint({
      appServer: {
        start: {
          transport: "websocket",
          command: "codex",
          args: [],
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "secret-token",
          headers: {},
        },
        connectionClass: "remote",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      },
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/home/oai/.codex",
      },
    });
    const second = buildCodexAppServerRuntimeFingerprint({
      appServer: {
        start: {
          transport: "websocket",
          command: "codex",
          args: [],
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "secret-token",
          headers: {},
        },
        connectionClass: "remote",
      },
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/home/oai/.codex",
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-token");
    expect(second).not.toContain("secret-token");
  });

  it("fingerprints the effective user Codex home for supervised connections", () => {
    const appServer = {
      start: {
        transport: "stdio" as const,
        homeScope: "user" as const,
        command: "codex",
        args: ["app-server"],
        headers: {},
      },
      connectionClass: "local-loopback" as const,
    };
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home-one");
    const first = buildCodexAppServerConnectionFingerprint(appServer);
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home-two");
    const second = buildCodexAppServerConnectionFingerprint(appServer);

    expect(first).not.toEqual(second);
  });
});

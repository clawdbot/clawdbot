import { beforeEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../logger.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));

describe("resolveMcpTransportConfig", () => {
  beforeEach(() => {
    vi.mocked(logWarn).mockClear();
  });

  it("resolves stdio config with connection timeout", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      args: ["./server.mjs"],
      connectionTimeoutMs: 12_345,
    });

    expect(resolved).toEqual({
      kind: "stdio",
      transportType: "stdio",
      command: "node",
      args: ["./server.mjs"],
      env: undefined,
      cwd: undefined,
      description: "node ./server.mjs",
      connectionTimeoutMs: 12_345,
    });
  });

  it("drops dangerous env overrides from stdio config", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      env: {
        SAFE_VALUE: "ok",
        PORT: 3000,
        ENABLED: true,
        GITHUB_TOKEN: "token",
        HTTP_PROXY: "http://proxy.example",
        NODE_OPTIONS: "--require=./evil.js",
        LD_PRELOAD: "/tmp/pwn.so",
        BASH_ENV: "/tmp/pwn.sh",
      },
    });

    expect(resolved).toEqual({
      kind: "stdio",
      transportType: "stdio",
      command: "node",
      args: undefined,
      env: {
        SAFE_VALUE: "ok",
        PORT: "3000",
        ENABLED: "true",
        GITHUB_TOKEN: "token",
        HTTP_PROXY: "http://proxy.example",
      },
      cwd: undefined,
      description: "node",
      connectionTimeoutMs: 30_000,
    });
    expect(logWarn).toHaveBeenCalledWith(
      'bundle-mcp: server "probe": env "NODE_OPTIONS" is blocked for stdio startup safety and was ignored.',
    );
    expect(logWarn).toHaveBeenCalledWith(
      'bundle-mcp: server "probe": env "LD_PRELOAD" is blocked for stdio startup safety and was ignored.',
    );
    expect(logWarn).toHaveBeenCalledWith(
      'bundle-mcp: server "probe": env "BASH_ENV" is blocked for stdio startup safety and was ignored.',
    );
  });

  it("uses an explicit empty stdio env when all configured env keys are blocked", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      command: "node",
      env: {
        NODE_OPTIONS: "--require=./evil.js",
        BASH_ENV: "/tmp/pwn.sh",
      },
    });

    expect(resolved).toEqual({
      kind: "stdio",
      transportType: "stdio",
      command: "node",
      args: undefined,
      env: {},
      cwd: undefined,
      description: "node",
      connectionTimeoutMs: 30_000,
    });
  });

  it("sanitizes config-controlled names in stdio env warnings", () => {
    resolveMcpTransportConfig("probe\nWARN forged\u001b[31m", {
      command: "node",
      env: {
        "LD_PRELOAD\nWARN forged\u001b[31m": "/tmp/pwn.so",
      },
    });

    expect(logWarn).toHaveBeenCalledWith(
      'bundle-mcp: server "probeWARN forged": env "LD_PRELOADWARN forged" is blocked for stdio startup safety and was ignored.',
    );
  });

  it("resolves SSE config by default", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": 42,
      },
    });

    expect(resolved).toEqual({
      kind: "http",
      transportType: "sse",
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": "42",
      },
      description: "https://mcp.example.com/sse",
      connectionTimeoutMs: 30_000,
    });
  });

  it("keeps HTTP header parsing unchanged for env-like names", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/sse",
      headers: {
        NODE_OPTIONS: "allowed-header",
      },
    });

    expect(resolved).toEqual({
      kind: "http",
      transportType: "sse",
      url: "https://mcp.example.com/sse",
      headers: {
        NODE_OPTIONS: "allowed-header",
      },
      description: "https://mcp.example.com/sse",
      connectionTimeoutMs: 30_000,
    });
  });

  it("resolves explicit streamable HTTP config", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/http",
      transport: "streamable-http",
    });

    expect(resolved).toEqual({
      kind: "http",
      transportType: "streamable-http",
      url: "https://mcp.example.com/http",
      headers: undefined,
      description: "https://mcp.example.com/http",
      connectionTimeoutMs: 30_000,
    });
  });

  it("treats CLI-native http type as streamable HTTP for compatibility", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      url: "https://mcp.example.com/http",
      type: "http",
    });

    expect(resolved).toEqual({
      kind: "http",
      transportType: "streamable-http",
      url: "https://mcp.example.com/http",
      headers: undefined,
      description: "https://mcp.example.com/http",
      connectionTimeoutMs: 30_000,
    });
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayScopedOptions } from "../../gateway/call.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { callGatewayTool, resolveGatewayOptions } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  configState: {
    value: {} as Record<string, unknown>,
  },
}));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => mocks.configState.value,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));

function capturedGatewayCall(): CallGatewayScopedOptions {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  const call = mocks.callGateway.mock.calls[0];
  if (!call) {
    throw new Error("expected callGateway to be called");
  }
  return call[0] as CallGatewayScopedOptions;
}

describe("gateway tool defaults", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
  };

  beforeEach(() => {
    mocks.callGateway.mockClear();
    mocks.configState.value = {};
    setActivePluginRegistry(createEmptyPluginRegistry());
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterAll(() => {
    if (envSnapshot.openclaw === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = envSnapshot.openclaw;
    }
  });

  it("leaves url undefined so callGateway can use config", () => {
    const opts = resolveGatewayOptions();
    expect(opts.url).toBeUndefined();
  });

  it("accepts allowlisted gatewayUrl overrides (SSRF hardening)", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "health",
      { gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t", timeoutMs: 5000 },
      {},
    );
    const call = capturedGatewayCall();
    expect(call.method).toBe("health");
    expect(call.params).toEqual({});
    expect(call.url).toBe("ws://127.0.0.1:18789");
    expect(call.token).toBe("t");
    expect(call.timeoutMs).toBe(5000);
    expect(call.scopes).toEqual(["operator.read"]);
  });

  it("uses OPENCLAW_GATEWAY_TOKEN for allowlisted local overrides", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.url).toBe("ws://127.0.0.1:18789");
    expect(opts.token).toBe("env-token");
  });

  it("falls back to config gateway.auth.token when env is unset for local overrides", () => {
    mocks.configState.value = {
      gateway: {
        auth: { token: "config-token" },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.token).toBe("config-token");
  });

  it("uses gateway.remote.token for allowlisted remote overrides", () => {
    mocks.configState.value = {
      gateway: {
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" });
    expect(opts.url).toBe("wss://gateway.example");
    expect(opts.token).toBe("remote-token");
  });

  it("does not leak local env/config tokens to remote overrides", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env-token";
    mocks.configState.value = {
      gateway: {
        auth: { token: "local-config-token" },
        remote: {
          url: "wss://gateway.example",
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" });
    expect(opts.token).toBeUndefined();
  });

  it("ignores unresolved local token SecretRef for strict remote overrides", () => {
    mocks.configState.value = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_LOCAL_TOKEN" },
        },
        remote: {
          url: "wss://gateway.example",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" });
    expect(opts.token).toBeUndefined();
  });

  it("explicit gatewayToken overrides fallback token resolution", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env-token";
    mocks.configState.value = {
      gateway: {
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };
    const opts = resolveGatewayOptions({
      gatewayUrl: "wss://gateway.example",
      gatewayToken: "explicit-token",
    });
    expect(opts.token).toBe("explicit-token");
  });

  it("uses least-privilege write scope for write methods", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("wake", {}, { mode: "now", text: "hi" });
    const call = capturedGatewayCall();
    expect(call.method).toBe("wake");
    expect(call.params).toEqual({ mode: "now", text: "hi" });
    expect(call.scopes).toEqual(["operator.write"]);
  });

  it("uses admin scope only for admin methods", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("cron.add", {}, { id: "job-1" });
    const call = capturedGatewayCall();
    expect(call.method).toBe("cron.add");
    expect(call.params).toEqual({ id: "job-1" });
    expect(call.scopes).toEqual(["operator.admin"]);
  });

  it("derives plugin session action scopes from call params", async () => {
    const registry = createEmptyPluginRegistry();
    registry.sessionActions = [
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "approve",
          requiredScopes: ["operator.approvals"],
          handler: () => ({ result: { ok: true } }),
        },
      },
    ];
    setActivePluginRegistry(registry);
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "plugins.sessionAction",
      {},
      {
        pluginId: "scope-plugin",
        actionId: "approve",
        sessionKey: "agent:main:main",
      },
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugins.sessionAction",
        scopes: ["operator.approvals"],
      }),
    );
  });

  it("falls back to broad scopes when a plugin session action is not locally registered", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "plugins.sessionAction",
      {},
      {
        pluginId: "remote-plugin",
        actionId: "approve",
      },
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugins.sessionAction",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
          "operator.talk.secrets",
        ],
      }),
    );
  });

  it("allows explicit scope overrides for dynamic callers", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "node.pair.approve",
      {},
      { requestId: "req-1" },
      { scopes: ["operator.admin"] },
    );
    const call = capturedGatewayCall();
    expect(call.method).toBe("node.pair.approve");
    expect(call.params).toEqual({ requestId: "req-1" });
    expect(call.scopes).toEqual(["operator.admin"]);
  });

  it("default-denies unknown methods by sending no scopes", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("nonexistent.method", {}, {});
    const call = capturedGatewayCall();
    expect(call.method).toBe("nonexistent.method");
    expect(call.params).toEqual({});
    expect(call.scopes).toEqual([]);
  });

  it("rejects non-allowlisted overrides (SSRF hardening)", async () => {
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:8080", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://169.254.169.254", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
  });
});

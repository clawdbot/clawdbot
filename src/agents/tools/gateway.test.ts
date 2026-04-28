import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const configState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => configState.value,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

let callGatewayTool: typeof import("./gateway.js").callGatewayTool;
let resolveGatewayOptions: typeof import("./gateway.js").resolveGatewayOptions;

describe("gateway tool defaults", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
  };

  beforeAll(async () => {
    ({ callGatewayTool, resolveGatewayOptions } = await import("./gateway.js"));
  });

  beforeEach(() => {
    callGatewayMock.mockClear();
    configState.value = {};
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
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "health",
      { gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t", timeoutMs: 5000 },
      {},
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "t",
        timeoutMs: 5000,
        scopes: ["operator.read"],
      }),
    );
  });

  it("uses OPENCLAW_GATEWAY_TOKEN for allowlisted local overrides", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.url).toBe("ws://127.0.0.1:18789");
    expect(opts.token).toBe("env-token");
  });

  it("falls back to config gateway.auth.token when env is unset for local overrides", () => {
    configState.value = {
      gateway: {
        auth: { token: "config-token" },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.token).toBe("config-token");
  });

  it("uses gateway.remote.token for allowlisted remote overrides", () => {
    configState.value = {
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
    configState.value = {
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
    configState.value = {
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
    configState.value = {
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
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("wake", {}, { mode: "now", text: "hi" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wake",
        scopes: ["operator.write"],
      }),
    );
  });

  it("uses admin scope only for admin methods", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("cron.add", {}, { id: "job-1" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.add",
        scopes: ["operator.admin"],
      }),
    );
  });

  it("allows explicit scope overrides for dynamic callers", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "node.pair.approve",
      {},
      { requestId: "req-1" },
      { scopes: ["operator.admin"] },
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        scopes: ["operator.admin"],
      }),
    );
  });

  it("default-denies unknown methods by sending no scopes", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("nonexistent.method", {}, {});
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nonexistent.method",
        scopes: [],
      }),
    );
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

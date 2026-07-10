// Gateway call helper tests pin URL override, token, and RPC scope behavior for
// agent tools that route through the local gateway client.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callGatewayTool, readGatewayCallOptions, resolveGatewayOptions } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  configState: {
    value: {} as Record<string, unknown>,
  },
  deviceIdentity: {
    deviceId: "agent-tool-device",
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
  },
  persistedDeviceIdentity: undefined as
    | {
        deviceId: string;
        publicKeyPem: string;
        privateKeyPem: string;
      }
    | null
    | undefined,
  deviceIdentityError: undefined as Error | undefined,
}));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => mocks.configState.value,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));
vi.mock("../../infra/device-identity.js", () => ({
  loadDeviceIdentityIfPresent: () =>
    mocks.persistedDeviceIdentity === undefined
      ? mocks.deviceIdentity
      : mocks.persistedDeviceIdentity,
  loadOrCreateDeviceIdentity: () => {
    if (mocks.deviceIdentityError) {
      throw mocks.deviceIdentityError;
    }
    return mocks.deviceIdentity;
  },
}));

function capturedGatewayCall(): CallGatewayOptions {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  const call = mocks.callGateway.mock.calls[0];
  if (!call) {
    throw new Error("expected callGateway to be called");
  }
  return call[0] as CallGatewayOptions;
}

describe("gateway tool defaults", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
  };

  beforeEach(() => {
    mocks.callGateway.mockClear();
    mocks.deviceIdentityError = undefined;
    mocks.persistedDeviceIdentity = undefined;
    mocks.configState.value = {};
    setActivePluginRegistry(createEmptyPluginRegistry());
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  afterAll(() => {
    if (envSnapshot.openclaw === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = envSnapshot.openclaw;
    }
    if (envSnapshot.gatewayUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = envSnapshot.gatewayUrl;
    }
  });

  it("leaves url undefined so callGateway can use config", () => {
    const opts = resolveGatewayOptions();
    expect(opts.url).toBeUndefined();
    expect(opts.target).toBe("local");
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

  it("rejects invalid gateway timeoutMs before RPC", async () => {
    expect(() => readGatewayCallOptions({ timeoutMs: -1 })).toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(() => readGatewayCallOptions({ timeoutMs: 1.5 })).toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("accepts string gateway timeoutMs through the shared numeric reader", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool("health", readGatewayCallOptions({ timeoutMs: "5000" }), {});

    expect(capturedGatewayCall().timeoutMs).toBe(5000);
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
    // Remote gateway overrides must use their own configured token; the local
    // daemon token is scoped to loopback-style endpoints only.
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
    // Session actions can define narrower scopes than the generic plugin RPC;
    // preserve that least-privilege contract when the registry is available.
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

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    const [[callParams]] = mocks.callGateway.mock.calls as unknown as Array<
      [{ method?: string; scopes?: string[] }]
    >;
    expect(callParams.method).toBe("plugins.sessionAction");
    expect(callParams.scopes).toEqual(["operator.approvals"]);
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

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    const [[callParams]] = mocks.callGateway.mock.calls as unknown as Array<
      [{ method?: string; scopes?: string[] }]
    >;
    expect(callParams.method).toBe("plugins.sessionAction");
    expect(callParams.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
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

  it("marks local approval request calls as approval runtime calls", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "approval-id" });

    await callGatewayTool("exec.approval.request", {}, { command: "printf hi" });

    const call = capturedGatewayCall();
    expect(call.method).toBe("exec.approval.request");
    expect(call.scopes).toEqual(["operator.approvals"]);
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it.each([
    {
      name: "approved flag",
      params: { approved: true, runId: "approval-inline" },
    },
    {
      name: "allow-once decision",
      params: { approvalDecision: "allow-once", runId: "approval-async" },
    },
    {
      name: "allow-always decision",
      params: { approvalDecision: "allow-always", runId: "approval-always" },
    },
  ])("binds persisted device identity to node system.run with $name", async ({ params }) => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "node.invoke",
      {},
      { nodeId: "node-1", command: "system.run", params, idempotencyKey: "invoke-1" },
      { scopes: ["operator.write", "operator.approvals"] },
    );

    const call = capturedGatewayCall();
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
    expect(call).not.toHaveProperty("approvalRuntimeToken");
  });

  it.each([
    {
      name: "unapproved system.run",
      command: "system.run",
      params: { approved: false },
    },
    {
      name: "system.run.prepare",
      command: "system.run.prepare",
      params: { approved: true, approvalDecision: "allow-once" },
    },
    {
      name: "unrelated node command",
      command: "system.info",
      params: { approved: true, approvalDecision: "allow-always" },
    },
  ])("keeps ordinary node.invoke device-less for $name", async ({ command, params }) => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "node.invoke",
      {},
      {
        nodeId: "node-1",
        command,
        params,
        idempotencyKey: "invoke-1",
      },
    );

    const call = capturedGatewayCall();
    expect(call).not.toHaveProperty("deviceIdentity");
    expect(call).not.toHaveProperty("approvalRuntimeToken");
  });

  it("fails approved node system.run closed without a persisted identity", async () => {
    mocks.persistedDeviceIdentity = null;

    await expect(
      callGatewayTool(
        "node.invoke",
        {},
        {
          nodeId: "node-1",
          command: "system.run",
          params: { approved: true, runId: "approval-id" },
          idempotencyKey: "invoke-1",
        },
        { scopes: ["operator.write", "operator.approvals"] },
      ),
    ).rejects.toThrow("approved node gateway calls require a stable device identity");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("reuses an existing replay identity without trying to create one", async () => {
    mocks.deviceIdentityError = new Error("must not create identity during replay");
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "node.invoke",
      {},
      {
        nodeId: "node-1",
        command: "system.run",
        params: { approved: true, runId: "approval-id" },
        idempotencyKey: "invoke-1",
      },
      { scopes: ["operator.write", "operator.approvals"] },
    );

    expect(capturedGatewayCall().deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("does not mark direct cron helper calls with agent runtime identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "job-1" });

    await callGatewayTool("cron.remove", {}, { id: "job-1" });

    const call = capturedGatewayCall();
    expect(call.method).toBe("cron.remove");
    expect(call.params).toEqual({ id: "job-1" });
    expect(call).not.toHaveProperty("agentRuntimeIdentityToken");
  });

  it("marks local cron calls from trusted tool context with agent runtime identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "job-1" });

    await withGatewayToolCallerIdentity(
      { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
      async () => {
        await callGatewayTool("cron.remove", {}, { id: "job-1" });
      },
    );

    const call = capturedGatewayCall();
    expect(call.method).toBe("cron.remove");
    expect(call.params).toEqual({ id: "job-1" });
    expect(call.agentRuntimeIdentityToken).toEqual(expect.any(String));
  });

  it("marks local wake calls from trusted tool context with agent runtime identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await withGatewayToolCallerIdentity(
      { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
      async () => {
        await callGatewayTool("wake", {}, { mode: "now", text: "ping" });
      },
    );

    const call = capturedGatewayCall();
    expect(call.method).toBe("wake");
    expect(call.agentRuntimeIdentityToken).toEqual(expect.any(String));
  });

  it("explains stale gateway cron connection metadata rejections", async () => {
    mocks.callGateway.mockRejectedValueOnce(
      new Error(
        "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
      ),
    );

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
        async () => {
          await callGatewayTool("cron.remove", {}, { id: "job-1" });
        },
      ),
    ).rejects.toThrow(
      "The running Gateway is from an older OpenClaw build and rejected current agent runtime connection metadata. Restart the Gateway with `openclaw gateway restart`, then retry.",
    );

    const call = capturedGatewayCall();
    expect(call.agentRuntimeIdentityToken).toEqual(expect.any(String));
  });

  it("explains fail-closed stale gateway cron identity rejections", async () => {
    mocks.callGateway.mockRejectedValueOnce(
      new Error(
        "gateway rejected required agent runtime identity auth field; refusing to retry without it",
      ),
    );

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
        async () => {
          await callGatewayTool("cron.remove", {}, { id: "job-1" });
        },
      ),
    ).rejects.toThrow(
      "The running Gateway is from an older OpenClaw build and rejected current agent runtime connection metadata. Restart the Gateway with `openclaw gateway restart`, then retry.",
    );

    const call = capturedGatewayCall();
    expect(call.agentRuntimeIdentityToken).toEqual(expect.any(String));
  });

  it("does not rewrite stale gateway validation errors for unscoped cron calls", async () => {
    const originalError = new Error(
      "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
    );
    mocks.callGateway.mockRejectedValueOnce(originalError);

    await expect(callGatewayTool("cron.remove", {}, { id: "job-1" })).rejects.toBe(originalError);
  });

  it("fails contextual cron calls closed for gatewayUrl overrides", async () => {
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
        async () => {
          await callGatewayTool(
            "cron.remove",
            { gatewayUrl: "ws://127.0.0.1:18789" },
            { id: "job-1" },
          );
        },
      ),
    ).rejects.toThrow("agent gateway calls require the trusted local gateway context");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("fails contextual cron calls closed for explicit gateway tokens", async () => {
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
        async () => {
          await callGatewayTool("cron.remove", { gatewayToken: "token" }, { id: "job-1" });
        },
      ),
    ).rejects.toThrow("agent gateway calls require the trusted local gateway context");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("fails contextual cron calls closed for configured remote gateways", async () => {
    mocks.configState.value = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ops", sessionKey: "agent:ops:telegram:direct:alice" },
        async () => {
          await callGatewayTool("cron.remove", {}, { id: "job-1" });
        },
      ),
    ).rejects.toThrow("agent gateway calls require the trusted local gateway context");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("marks local approval wait calls as approval runtime calls", async () => {
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.method).toBe("exec.approval.waitDecision");
    expect(call.scopes).toEqual(["operator.approvals"]);
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("marks local plugin approval wait calls with runtime and device identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("plugin.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.method).toBe("plugin.approval.waitDecision");
    expect(call.scopes).toEqual(["operator.approvals"]);
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("marks local plugin approval request calls with runtime and device identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "plugin:approval-id" });

    await callGatewayTool("plugin.approval.request", {}, { title: "approve", description: "test" });

    const call = capturedGatewayCall();
    expect(call.method).toBe("plugin.approval.request");
    expect(call.scopes).toEqual(["operator.approvals"]);
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("marks local approval resolve calls as approval runtime calls", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "exec.approval.resolve",
      {},
      { id: "approval-id", decision: "allow-once" },
    );

    const call = capturedGatewayCall();
    expect(call.method).toBe("exec.approval.resolve");
    expect(call.scopes).toEqual(["operator.approvals"]);
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("does not attach agent provenance to ordinary contextual approval resolutions", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main" },
      async () => {
        await callGatewayTool(
          "exec.approval.resolve",
          {},
          { id: "approval-id", decision: "allow-once" },
        );
      },
    );

    const call = capturedGatewayCall();
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call).not.toHaveProperty("agentRuntimeIdentityToken");
  });

  it("attaches trusted agent identity to local auto-review resolution calls", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main" },
      async () => {
        await callGatewayTool(
          "exec.approval.resolve",
          {},
          { id: "approval-id", decision: "allow-once" },
          { requireAgentRuntimeIdentity: true },
        );
      },
    );

    const call = capturedGatewayCall();
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call.agentRuntimeIdentityToken).toEqual(expect.any(String));
  });

  it("fails required agent identity resolution calls closed outside agent context", async () => {
    await expect(
      callGatewayTool(
        "exec.approval.resolve",
        {},
        { id: "approval-id", decision: "allow-once" },
        { requireAgentRuntimeIdentity: true },
      ),
    ).rejects.toThrow("trusted agent runtime identity required for this gateway call");

    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("does not require device identity for local approval runtime calls", async () => {
    mocks.deviceIdentityError = new Error("state directory read-only");
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
    expect(call).not.toHaveProperty("deviceIdentity");
  });

  it("does not send the local approval runtime token to configured remote gateways", async () => {
    mocks.configState.value = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.url).toBeUndefined();
    expect(call.token).toBeUndefined();
    expect(call).not.toHaveProperty("approvalRuntimeToken");
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("keeps the local approval runtime token for remote mode without a remote URL", async () => {
    mocks.configState.value = {
      gateway: {
        mode: "remote",
      },
    };
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
    expect(call.approvalRuntimeToken).toEqual(expect.any(String));
  });

  it("does not send the local approval runtime token to env-selected gateways", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway.example";
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.url).toBeUndefined();
    expect(call).not.toHaveProperty("approvalRuntimeToken");
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("does not send the local approval runtime token to loopback env-selected gateways", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.url).toBeUndefined();
    expect(call).not.toHaveProperty("approvalRuntimeToken");
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("does not send the local approval runtime token to loopback env-selected gateway paths", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789/ws";
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" });

    const call = capturedGatewayCall();
    expect(call.url).toBeUndefined();
    expect(call).not.toHaveProperty("approvalRuntimeToken");
    expect(call.deviceIdentity).toEqual(mocks.deviceIdentity);
  });

  it("fails env-selected approval calls when requester device identity is unavailable", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    mocks.deviceIdentityError = new Error("state directory read-only");

    await expect(
      callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" }),
    ).rejects.toThrow("remote approval gateway calls require a stable device identity");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("fails remote approval calls when requester device identity is not persisted", async () => {
    mocks.configState.value = {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://127.0.0.1:18789",
          token: "remote-token",
        },
      },
    };
    mocks.persistedDeviceIdentity = null;
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await expect(
      callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" }),
    ).rejects.toThrow("remote approval gateway calls require a stable device identity");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("fails remote approval calls when requester device identity readback differs", async () => {
    mocks.configState.value = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };
    mocks.persistedDeviceIdentity = {
      ...mocks.deviceIdentity,
      deviceId: "other-device",
    };
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await expect(
      callGatewayTool("exec.approval.waitDecision", {}, { id: "approval-id" }),
    ).rejects.toThrow("remote approval gateway calls require a stable device identity");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("does not send the local approval runtime token to gatewayUrl overrides", async () => {
    // Approval runtime tokens are local IPC credentials, not bearer tokens for
    // user-supplied gateway URLs.
    mocks.callGateway.mockResolvedValueOnce({ decision: "allow-once" });

    await callGatewayTool(
      "exec.approval.waitDecision",
      { gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t" },
      { id: "approval-id" },
    );

    const call = capturedGatewayCall();
    expect(call.url).toBe("ws://127.0.0.1:18789");
    expect(call).not.toHaveProperty("approvalRuntimeToken");
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

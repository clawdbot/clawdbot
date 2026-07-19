// Operator approvals client e2e tests verify requester/approver scope behavior through a real gateway server.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalGetResult,
  type ApprovalHistoryResult,
  type ApprovalResolveResult,
  validateApprovalGetResult,
  validateApprovalHistoryResult,
  validateApprovalResolveResult,
} from "../../packages/gateway-protocol/src/index.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE, READ_SCOPE } from "./method-scopes.js";
import { withOperatorApprovalsGatewayClient } from "./operator-approvals-client.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "./test-helpers.e2e.js";

const TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_PORT",
];

type Cleanup = () => Promise<void> | void;

async function requestExecApproval(params: {
  requester: Awaited<ReturnType<typeof connectGatewayClient>>;
  id: string;
}): Promise<void> {
  await expect(
    params.requester.request("exec.approval.request", {
      id: params.id,
      command: "printf smoke",
      cwd: "/tmp",
      host: "local",
      ask: "always",
      twoPhase: true,
      // This suite drives the stable ID directly from another authenticated
      // device, so no legacy event delivery route is required.
      requireDeliveryRoute: false,
      timeoutMs: 60_000,
    }),
  ).resolves.toMatchObject({
    status: "accepted",
    id: params.id,
  });
}

describe("operator approval gateway client e2e", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it("uses runtime authority only for generated local gateway URLs", async () => {
    const envSnapshot = captureEnv(TEST_ENV_KEYS);
    cleanup.push(() => envSnapshot.restore());
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-approval-client-e2e-"));
    cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const port = await getFreeGatewayPort();
    const token = "approval-client-e2e-token";
    const url = `ws://127.0.0.1:${port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));

    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    cleanup.push(() => server.close());

    const admin = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "approval admin",
      scopes: [ADMIN_SCOPE],
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(admin));

    const requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "approval requester",
      scopes: [APPROVALS_SCOPE],
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(requester));

    const localConfig = {
      gateway: {
        port,
        auth: { mode: "token", token },
      },
    } satisfies OpenClawConfig;

    await requestExecApproval({ requester, id: "local-source-approval" });
    await withOperatorApprovalsGatewayClient(
      {
        config: localConfig,
        clientDisplayName: "local source approval resolver",
      },
      async (client) => {
        await client.request(
          "exec.approval.resolve",
          { id: "local-source-approval", decision: "allow-once" },
          { timeoutMs: 10_000 },
        );
      },
    );

    const remoteLoopbackConfig = {
      gateway: {
        mode: "remote",
        remote: { url },
        auth: { mode: "token", token },
      },
    } satisfies OpenClawConfig;

    await requestExecApproval({ requester, id: "remote-loopback-approval" });
    await expect(
      withOperatorApprovalsGatewayClient(
        {
          config: remoteLoopbackConfig,
          clientDisplayName: "remote loopback approval resolver",
        },
        async (client) => {
          await client.request(
            "exec.approval.resolve",
            { id: "remote-loopback-approval", decision: "allow-once" },
            { timeoutMs: 10_000 },
          );
        },
      ),
    ).rejects.toMatchObject({
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });

    await admin.request(
      "exec.approval.resolve",
      { id: "remote-loopback-approval", decision: "deny" },
      { timeoutMs: 10_000 },
    );
  }, 120_000);

  it("resolves one approval from distinct devices with first-answer-wins semantics", async () => {
    const envSnapshot = captureEnv(TEST_ENV_KEYS);
    cleanup.push(() => envSnapshot.restore());
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-approval-surfaces-e2e-"));
    cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const requesterIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "approval-requester.sqlite"),
    });
    const reviewerIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "approval-reviewer.sqlite"),
    });
    const underscopedIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "approval-underscoped.sqlite"),
    });
    expect(requesterIdentity.deviceId).not.toBe(reviewerIdentity.deviceId);

    const port = await getFreeGatewayPort();
    const token = "approval-surfaces-e2e-token";
    const url = `ws://127.0.0.1:${port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));

    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    cleanup.push(() => server.close());

    const requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "approval requester device",
      scopes: [APPROVALS_SCOPE],
      deviceIdentity: requesterIdentity,
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(requester));

    const reviewer = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "approval reviewer device",
      scopes: [APPROVALS_SCOPE],
      deviceIdentity: reviewerIdentity,
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(reviewer));

    const underscoped = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "approval underscoped device",
      scopes: [READ_SCOPE],
      deviceIdentity: underscopedIdentity,
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(underscoped));

    const approvalId = "multi-surface-first-answer-wins";
    await requestExecApproval({ requester, id: approvalId });

    const pending = await reviewer.request<ApprovalGetResult>("approval.get", { id: approvalId });
    expect(validateApprovalGetResult(pending)).toBe(true);
    expect(pending.approval).toMatchObject({
      id: approvalId,
      status: "pending",
      presentation: { kind: "exec" },
    });

    await expect(underscoped.request("approval.get", { id: approvalId })).rejects.toThrow(
      "missing scope: operator.approvals",
    );
    await expect(underscoped.request("approval.history", {})).rejects.toThrow(
      "missing scope: operator.approvals",
    );
    await expect(
      underscoped.request("approval.resolve", { id: approvalId, kind: "exec", decision: "deny" }),
    ).rejects.toThrow("missing scope: operator.approvals");

    const stillPending = await reviewer.request<ApprovalGetResult>("approval.get", {
      id: approvalId,
    });
    expect(validateApprovalGetResult(stillPending)).toBe(true);
    expect(stillPending.approval.status).toBe("pending");

    const [allowResult, denyResult] = await Promise.all([
      requester.request<ApprovalResolveResult>("approval.resolve", {
        id: approvalId,
        kind: "exec",
        decision: "allow-once",
      }),
      reviewer.request<ApprovalResolveResult>("approval.resolve", {
        id: approvalId,
        kind: "exec",
        decision: "deny",
      }),
    ]);
    expect(validateApprovalResolveResult(allowResult)).toBe(true);
    expect(validateApprovalResolveResult(denyResult)).toBe(true);
    expect([allowResult.applied, denyResult.applied].filter(Boolean)).toHaveLength(1);
    expect(allowResult.approval).toEqual(denyResult.approval);

    const winningDecision = allowResult.approval.status === "allowed" ? "allow-once" : "deny";
    expect(allowResult.approval).toMatchObject({
      id: approvalId,
      status: winningDecision === "deny" ? "denied" : "allowed",
      decision: winningDecision,
    });

    const replay = await reviewer.request<ApprovalResolveResult>("approval.resolve", {
      id: approvalId,
      kind: "exec",
      decision: winningDecision,
    });
    expect(validateApprovalResolveResult(replay)).toBe(true);
    expect(replay).toEqual({ applied: false, approval: allowResult.approval });

    const terminal = await requester.request<ApprovalGetResult>("approval.get", { id: approvalId });
    expect(validateApprovalGetResult(terminal)).toBe(true);
    expect(terminal.approval).toEqual(allowResult.approval);

    const history = await reviewer.request<ApprovalHistoryResult>("approval.history", {
      limit: 10,
    });
    expect(validateApprovalHistoryResult(history)).toBe(true);
    expect(history.items).toContainEqual(allowResult.approval);
  }, 120_000);
});

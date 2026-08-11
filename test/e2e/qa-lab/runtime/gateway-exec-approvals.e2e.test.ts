// Gateway exec approvals QA proves policy snapshots and approval decisions over real WebSockets.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecApprovalsSnapshot } from "../../../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../../../../src/gateway/method-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startTestGatewayServer,
} from "../../../../src/gateway/test-helpers.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { readExecApprovalsSnapshot } from "../../../../src/infra/exec-approvals.js";

type Cleanup = () => Promise<void> | void;

type ExecApprovalListEntry = {
  id: string;
  request: {
    command?: string;
  };
};

installGatewayTestHooks({ scope: "suite" });

describe("gateway exec approvals QA", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
  });

  it("protects policy snapshots and resolves a pending request from another reviewer", async () => {
    const port = await getFreePort();
    const token = "gateway-exec-approvals-qa-token";
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway QA fixtures");
    }

    const server = await startTestGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    cleanup.push(() => server.close());

    const requesterIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "exec-requester.sqlite"),
    });
    const reviewerIdentity = loadOrCreateDeviceIdentity({
      path: path.join(stateDir, "test-device-identities", "exec-reviewer.sqlite"),
    });
    expect(reviewerIdentity.deviceId).not.toBe(requesterIdentity.deviceId);

    const url = `ws://127.0.0.1:${port}`;
    const requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "exec approval requester",
      deviceIdentity: requesterIdentity,
      scopes: [APPROVALS_SCOPE],
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(requester));

    const reviewer = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "exec approval reviewer",
      deviceIdentity: reviewerIdentity,
      scopes: [ADMIN_SCOPE],
      timeoutMs: 60_000,
    });
    cleanup.push(() => disconnectGatewayClient(reviewer));

    const initial = await reviewer.request<ExecApprovalsSnapshot>("exec.approvals.get", {});
    const storedInitial = readExecApprovalsSnapshot();
    expect(storedInitial.file.socket?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(initial).toMatchObject({
      exists: true,
      hash: storedInitial.hash,
      file: {
        version: 1,
        socket: { path: storedInitial.file.socket?.path },
      },
    });
    expect(initial.file.socket).not.toHaveProperty("token");

    const replacement = {
      version: 1 as const,
      defaults: {
        security: "allowlist",
        ask: "always",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {
        main: {
          allowlist: [{ pattern: "printf gateway-qa" }],
        },
      },
    };
    const updated = await reviewer.request<ExecApprovalsSnapshot>("exec.approvals.set", {
      baseHash: initial.hash,
      file: replacement,
    });
    expect(updated.hash).not.toBe(initial.hash);
    expect(updated.file).toMatchObject({
      ...replacement,
      socket: { path: storedInitial.file.socket?.path },
    });
    expect(updated.file.socket).not.toHaveProperty("token");
    expect(readExecApprovalsSnapshot().file.socket?.token).toBe(storedInitial.file.socket?.token);

    await expect(
      reviewer.request("exec.approvals.set", {
        baseHash: initial.hash,
        file: {
          ...replacement,
          defaults: { ...replacement.defaults, security: "deny" },
        },
      }),
    ).rejects.toThrow("exec approvals changed since last load");
    await expect(
      reviewer.request<ExecApprovalsSnapshot>("exec.approvals.get", {}),
    ).resolves.toEqual(updated);

    const approvalId = "gateway-exec-approvals-qa";
    await expect(
      requester.request("exec.approval.request", {
        id: approvalId,
        command: "printf gateway-qa",
        commandArgv: ["printf", "gateway-qa"],
        cwd: "/tmp",
        host: "gateway",
        ask: "always",
        twoPhase: true,
        requireDeliveryRoute: false,
        timeoutMs: 60_000,
      }),
    ).resolves.toMatchObject({ id: approvalId, status: "accepted" });

    const pending = await requester.request<ExecApprovalListEntry[]>("exec.approval.list", {});
    expect(pending).toContainEqual(
      expect.objectContaining({
        id: approvalId,
        request: expect.objectContaining({ command: "printf gateway-qa" }),
      }),
    );
    await expect(requester.request("exec.approval.get", { id: approvalId })).resolves.toMatchObject(
      {
        id: approvalId,
        commandText: "printf gateway-qa",
        host: "gateway",
        nodeId: null,
        agentId: null,
      },
    );

    let waitSettled = false;
    const waitDecision = requester
      .request<{
        id: string;
        decision: string;
      }>("exec.approval.waitDecision", { id: approvalId }, { timeoutMs: 10_000 })
      .finally(() => {
        waitSettled = true;
      });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(waitSettled).toBe(false);

    await expect(
      reviewer.request("exec.approval.resolve", {
        id: approvalId,
        decision: "allow-once",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(waitDecision).resolves.toMatchObject({
      id: approvalId,
      decision: "allow-once",
    });

    const remaining = await requester.request<ExecApprovalListEntry[]>("exec.approval.list", {});
    expect(remaining.map((entry) => entry.id)).not.toContain(approvalId);
    await expect(requester.request("exec.approval.get", { id: approvalId })).rejects.toThrow(
      "unknown or expired approval id",
    );
  }, 120_000);
});

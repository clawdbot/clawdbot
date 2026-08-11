import path from "node:path";
// Proves the plugin approval lifecycle through authenticated Gateway WebSockets.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
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
import { setLoggerOverride } from "../../../../src/logging.js";

type Cleanup = () => Promise<void> | void;

type ApprovalEvent = {
  event?: string;
  payload?: unknown;
};

type ApprovalRecord = {
  id: string;
  request: {
    allowedDecisions?: string[];
    pluginId?: string | null;
  };
};

type ApprovalDecision = {
  createdAtMs: number;
  decision: string;
  expiresAtMs: number;
  id: string;
  terminalReason: string | null;
};

const requireRecord = createRequireRecord("record", "expected-label");

installGatewayTestHooks({ scope: "suite" });

describe("gateway plugin approvals QA", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
  });

  it("delivers a generated request to a distinct reviewer and resolves one terminal decision", async () => {
    let stage = "fixture setup";
    const markStage = (next: string) => {
      stage = next;
      console.info(`[gateway-plugin-approvals] stage=${stage}`);
    };

    try {
      // Keep normal test logs quiet while exposing the existing ws-control
      // handshake phase if this real connection fails before hello-ok.
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });

      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        throw new Error("OPENCLAW_STATE_DIR is required for gateway QA fixtures");
      }
      const reviewerIdentity = loadOrCreateDeviceIdentity({
        path: path.join(stateDir, "test-device-identities", "plugin-approval-reviewer.sqlite"),
      });
      const requesterIdentity = loadOrCreateDeviceIdentity({
        path: path.join(stateDir, "test-device-identities", "plugin-approval-requester.sqlite"),
      });
      expect(reviewerIdentity.deviceId).not.toBe(requesterIdentity.deviceId);

      markStage("gateway start");
      const port = await getFreePort();
      const token = "gateway-plugin-approvals-qa-token";
      const url = `ws://127.0.0.1:${port}`;
      const server = await startTestGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      cleanup.push(() => server.close());

      const approvalEvents: ApprovalEvent[] = [];
      markStage("reviewer connect");
      const reviewer = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "plugin approval reviewer",
        scopes: [ADMIN_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        deviceIdentity: reviewerIdentity,
        onEvent: (event) => {
          if (
            event.event === "plugin.approval.requested" ||
            event.event === "plugin.approval.resolved"
          ) {
            approvalEvents.push(event);
          }
        },
        timeoutMs: 60_000,
      });
      cleanup.push(() => disconnectGatewayClient(reviewer));

      markStage("requester connect");
      const requester = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "plugin approval requester",
        scopes: [APPROVALS_SCOPE],
        deviceIdentity: requesterIdentity,
        timeoutMs: 60_000,
      });
      cleanup.push(() => disconnectGatewayClient(requester));

      markStage("approval request");
      const accepted = await requester.request<{
        deliveryRoute: string;
        id: string;
        status: string;
      }>("plugin.approval.request", {
        pluginId: "qa-plugin",
        title: "Allow fixture mutation",
        description: "The QA fixture requests one bounded mutation.",
        allowedDecisions: ["allow-once"],
        twoPhase: true,
        timeoutMs: 30_000,
      });
      expect(accepted).toMatchObject({
        status: "accepted",
        deliveryRoute: "approval-client",
      });
      expect(accepted.id).toMatch(/^plugin:[0-9a-f-]{36}$/);

      markStage("requested event");
      await vi.waitFor(() => {
        expect(
          approvalEvents.filter((event) => event.event === "plugin.approval.requested"),
        ).toHaveLength(1);
      });
      const requestedEvent = approvalEvents.find(
        (event) => event.event === "plugin.approval.requested",
      );
      expect(
        requireRecord(requestedEvent?.payload, "plugin approval requested event"),
      ).toMatchObject({
        id: accepted.id,
        request: {
          pluginId: "qa-plugin",
          allowedDecisions: ["allow-once", "deny"],
        },
      });

      markStage("pending inventory");
      const pending = await reviewer.request<ApprovalRecord[]>("plugin.approval.list", {});
      expect(pending).toEqual([
        expect.objectContaining({
          id: accepted.id,
          request: expect.objectContaining({
            pluginId: "qa-plugin",
            allowedDecisions: ["allow-once", "deny"],
          }),
        }),
      ]);

      markStage("wait decision pending");
      let waitSettled = false;
      const waitDecision = requester
        .request<ApprovalDecision>(
          "plugin.approval.waitDecision",
          { id: accepted.id },
          { timeoutMs: 10_000 },
        )
        .finally(() => {
          waitSettled = true;
        });
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(waitSettled).toBe(false);

      markStage("reviewer resolve");
      await expect(
        reviewer.request("plugin.approval.resolve", {
          id: accepted.id,
          decision: "allow-once",
        }),
      ).resolves.toEqual({ ok: true });

      markStage("terminal decision");
      const terminalDecision = await waitDecision;
      await vi.waitFor(() => {
        expect(
          approvalEvents.filter((event) => event.event === "plugin.approval.resolved"),
        ).toHaveLength(1);
      });
      const resolvedEvent = approvalEvents.find(
        (event) => event.event === "plugin.approval.resolved",
      );
      const resolvedPayload = requireRecord(
        resolvedEvent?.payload,
        "plugin approval resolved event",
      );
      const waitTerminalDecision = {
        id: terminalDecision.id,
        decision: terminalDecision.decision,
      };
      const eventTerminalDecision = {
        id: resolvedPayload.id,
        decision: resolvedPayload.decision,
      };
      expect(waitTerminalDecision).toEqual({
        id: accepted.id,
        decision: "allow-once",
      });
      expect(eventTerminalDecision).toEqual(waitTerminalDecision);
      expect(terminalDecision.createdAtMs).toEqual(expect.any(Number));
      expect(terminalDecision.expiresAtMs).toEqual(expect.any(Number));
      expect(terminalDecision.expiresAtMs).toBeGreaterThan(terminalDecision.createdAtMs);
      expect(terminalDecision.terminalReason).toBe("user");

      markStage("pending inventory empty");
      await expect(reviewer.request<ApprovalRecord[]>("plugin.approval.list", {})).resolves.toEqual(
        [],
      );
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`[gateway-plugin-approvals] failed stage=${stage}: ${detail}`, {
        cause: error,
      });
    }
  }, 120_000);
});

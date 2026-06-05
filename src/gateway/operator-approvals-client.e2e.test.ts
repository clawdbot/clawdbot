// Operator approvals client e2e tests verify requester/approver scope behavior through a real gateway server.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureEnv } from "../test-utils/env.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "./method-scopes.js";
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
      timeoutMs: 60_000,
    }),
  ).resolves.toMatchObject({
    status: "accepted",
    id: params.id,
  });
}

describe("operator approval gateway client runtime token source", () => {
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
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-approval-client-e2e-"));
    cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const port = await getFreeGatewayPort();
    const token = "approval-client-e2e-token";
    const url = `ws://127.0.0.1:${port}`;
    process.env.OPENCLAW_GATEWAY_PORT = String(port);

    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      deferStartupSidecars: true,
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
});

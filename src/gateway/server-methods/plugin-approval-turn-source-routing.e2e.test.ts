// Gateway e2e proof: real delivery routes change approval response behavior.
//
// Without turn-source fields: plugin.approval.request expires immediately with
// {decision: null} because there is no approval client and no turn-source route.
//
// With a connected approval-capable client: the approval stays alive and
// returns {status: "accepted"} because it has a real delivery route.
//
// This test runs against a real gateway server with no Telegram required.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { APPROVALS_SCOPE } from "../method-scopes.js";
import { startGatewayServer } from "../server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../test-helpers.e2e.js";

const TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_PORT",
];

describe("plugin.approval.request delivery routing (real gateway)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let requester: Awaited<ReturnType<typeof connectGatewayClient>>;
  let approvalClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let connectApprovalClient: () => Promise<Awaited<ReturnType<typeof connectGatewayClient>>>;

  beforeAll(async () => {
    envSnapshot = captureEnv(TEST_ENV_KEYS);
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");

    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-plugin-approval-turn-source-e2e-"),
    );
    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const port = await getFreeGatewayPort();
    const token = "plugin-approval-turn-source-e2e-token";
    const url = `ws://127.0.0.1:${port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));

    server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });

    // No operator approval client; only a requester with APPROVALS_SCOPE.
    // This is the state that triggers the no-route expiry in the unfixed code.
    requester = await connectGatewayClient({
      url,
      token,
      clientDisplayName: "plugin-approval requester",
      scopes: [APPROVALS_SCOPE],
      requestTimeoutMs: 5_000,
      timeoutMs: 60_000,
    });
    connectApprovalClient = () =>
      connectGatewayClient({
        url,
        token,
        clientDisplayName: "plugin approval client",
        scopes: [APPROVALS_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        timeoutMs: 60_000,
      });
  });

  afterAll(async () => {
    if (approvalClient) {
      await disconnectGatewayClient(approvalClient).catch(() => undefined);
    }
    await disconnectGatewayClient(requester).catch(() => undefined);
    await server?.close();
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    envSnapshot.restore();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it("expires with decision:null when no turn-source route and no approval client", async () => {
    // This is the bug: without turn-source fields, the gateway expires the record
    // immediately (decision: null) because there is no delivery route.
    const result = await requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
      // No turnSourceChannel/turnSourceTo/turnSourceAccountId/turnSourceThreadId
    });

    expect(result).toMatchObject({ decision: null });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
  });

  it("returns accepted when a real approval client is connected", async () => {
    approvalClient = await connectApprovalClient();

    const result = await requester.request("plugin.approval.request", {
      pluginId: "test-plugin",
      title: "Confirm action",
      description: "Plugin wants to perform an action",
      twoPhase: true,
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({ status: "accepted" });
    expect((result as { id?: string }).id).toMatch(/^plugin:/);
  });
});

/**
 * Gateway exec approval E2E tests.
 * Exercises a real gateway server approval flow, approval follow-up text, and
 * approval timeout behavior in an isolated temp config.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { ExecApprovalFollowupOutcome } from "./bash-tools.exec-types.js";
import { createExecTool } from "./bash-tools.exec.js";

const TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
];
const GATEWAY_CONNECT_TIMEOUT_MS = 120_000;
const EXEC_APPROVAL_E2E_TIMEOUT_MS = 180_000;

type Cleanup = () => Promise<void> | void;

describe("gateway-hosted exec approvals", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it(
    "lets OpenClaw-style gateway tool calls request and wait for approval over separate connections",
    async () => {
      const envSnapshot = captureEnv(TEST_ENV_KEYS);
      cleanup.push(() => envSnapshot.restore());

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approval-e2e-"));
      cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const port = await getFreeGatewayPort();
      const token = "exec-approval-e2e-token";
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              port,
              auth: { mode: "token", token },
            },
            tools: {
              exec: {
                host: "gateway",
                security: "allowlist",
                ask: "always",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
      setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
      setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
      setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
      setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
      setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
      setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
      setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      cleanup.push(() => server.close());

      const operator = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        clientDisplayName: "approval operator",
        mode: GATEWAY_CLIENT_MODES.TEST,
        scopes: [ADMIN_SCOPE],
        requestTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
        timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      });
      cleanup.push(() => disconnectGatewayClient(operator));

      let resolveOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
      const outcomePromise = new Promise<ExecApprovalFollowupOutcome>((resolve) => {
        resolveOutcome = resolve;
      });

      const tool = createExecTool({
        host: "gateway",
        security: "allowlist",
        ask: "always",
        cwd: workspaceDir,
        approvalRunningNoticeMs: 0,
        approvalFollowupMode: "direct",
        approvalFollowup: ({ outcome }) => {
          resolveOutcome(outcome);
          return undefined;
        },
      });

      const pending = await tool.execute("exec-approval-e2e", {
        command: "printf 'smoke\\n'",
        workdir: workspaceDir,
        timeout: 5,
      });

      expect(pending.details.status).toBe("approval-pending");
      if (pending.details.status !== "approval-pending") {
        throw new Error("expected approval-pending exec result");
      }

      await operator.request(
        "exec.approval.resolve",
        { id: pending.details.approvalId, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      const outcome = await withTimeout(outcomePromise, 15_000, {
        message: "timed out waiting for approved exec outcome",
      });
      expect(outcome.status).toBe("completed");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.aggregated).toBe("smoke");
    },
    EXEC_APPROVAL_E2E_TIMEOUT_MS,
  );
});

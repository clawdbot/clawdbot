/**
 * Gateway exec approval E2E tests.
 * Exercises a real gateway server approval flow, approval follow-up text, and
 * approval timeout behavior in an isolated temp config.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../gateway/test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../gateway/test-helpers.env.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withTimeout } from "../utils/with-timeout.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { getFinishedSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { ExecApprovalFollowupOutcome } from "./bash-tools.exec-types.js";

const TEST_ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
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

function requireApprovalId(details: unknown): string {
  const record = asNonArrayRecord(details);
  if (record?.status !== "approval-pending" || typeof record.approvalId !== "string") {
    throw new Error("expected approval-pending exec result");
  }
  return record.approvalId;
}

describe("gateway-hosted exec approvals", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    resetProcessRegistryForTests();
  });

  it(
    "keeps a scheduled approval floor in a reused full-permission session",
    async () => {
      const envSnapshot = captureEnv(TEST_ENV_KEYS);
      cleanup.push(() => envSnapshot.restore());

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approval-e2e-"));
      cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const port = await getGatewayE2ePortBlock();
      const token = "exec-approval-e2e-token";
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const config = {
        agents: {
          ownership: "explicit",
          defaults: { workspace: workspaceDir },
          list: [{ id: "main", tools: { exec: { cleanupMs: 180_000 } } }, { id: "helper" }],
        },
        gateway: {
          port,
          auth: { mode: "token", token },
        },
        tools: {
          exec: {
            host: "gateway",
            security: "full",
            ask: "off",
            cleanupMs: 60_000,
          },
        },
      } satisfies OpenClawConfig;
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

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
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        requestTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
        timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      });
      cleanup.push(() => disconnectGatewayClient(operator));

      let resolveOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
      let approvedProcessId: string | undefined;

      const tools = createOpenClawCodingTools({
        agentId: "main",
        workspaceDir,
        cwd: workspaceDir,
        config,
        sessionPermissionPolicy: { root: workspaceDir, mode: "full" },
        scheduledToolPolicy: {
          version: 1,
          mode: "trusted",
          execTarget: { host: "gateway", ask: "always" },
        },
        exec: {
          approvalRunningNoticeMs: 0,
          approvalFollowupMode: "direct",
          approvalFollowup: ({ outcome, sessionId }) => {
            approvedProcessId = sessionId;
            resolveOutcome(outcome);
            return undefined;
          },
        },
      });
      const tool = tools.find((candidate) => candidate.name === "exec");
      if (!tool) {
        throw new Error("expected scheduled exec tool");
      }

      const markerPath = path.join(workspaceDir, "denied-marker");
      const deniedPending = await tool.execute("exec-approval-e2e-denied", {
        command: `touch ${JSON.stringify(markerPath)}`,
        workdir: workspaceDir,
        timeoutSeconds: 5,
      });
      const deniedApprovalId = requireApprovalId(deniedPending.details);
      await operator.request(
        "exec.approval.resolve",
        { id: deniedApprovalId, decision: "deny" },
        { timeoutMs: 10_000 },
      );
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

      const allowedOutcomePromise = new Promise<ExecApprovalFollowupOutcome>((resolve) => {
        resolveOutcome = resolve;
      });

      const pending = await tool.execute("exec-approval-e2e", {
        command: "printf 'smoke\\n'",
        workdir: workspaceDir,
        timeoutSeconds: 5,
      });
      const approvalId = requireApprovalId(pending.details);

      const helperTools = createOpenClawCodingTools({ agentId: "helper", config, workspaceDir });
      const helperProcess = helperTools.find((candidate) => candidate.name === "process");
      if (!helperProcess) {
        throw new Error("expected helper process tool");
      }
      await helperProcess.execute("helper-process-during-approval", { action: "list" });

      await operator.request(
        "exec.approval.resolve",
        { id: approvalId, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      const outcome = await withTimeout(allowedOutcomePromise, 15_000, {
        message: "timed out waiting for approved exec outcome",
      });
      expect(outcome.status).toBe("completed");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.aggregated).toBe("smoke");
      if (!approvedProcessId) {
        throw new Error("expected the approved process identity");
      }
      const finished = getFinishedSession(approvedProcessId);
      if (!finished) {
        throw new Error("expected retained approved process output");
      }
      expect(finished.expiresAt - finished.endedAt).toBe(180_000);
    },
    EXEC_APPROVAL_E2E_TIMEOUT_MS,
  );
});

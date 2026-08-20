/**
 * Terminal exec-policy E2E tests.
 *
 * Exercises the agent terminal gate against a real gateway approval flow:
 * exec deny blocks the PTY open, and ask mode registers a bounded
 * "allow-once" approval that an operator resolves before the PTY opens.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import { TerminalSessionManager } from "../gateway/terminal/session-manager.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../gateway/test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../gateway/test-helpers.env.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withTimeout } from "../utils/with-timeout.js";
import { createTerminalTool } from "./tools/terminal-tool.js";

const TEST_ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
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
const TERMINAL_E2E_TIMEOUT_MS = 240_000;

type Cleanup = () => Promise<void> | void;

type PendingApprovalEntry = {
  id: string;
  request: { agentId?: string | null; sessionKey?: string | null; command?: string | null };
};

async function waitForPendingTerminalApproval(
  listPending: () => Promise<PendingApprovalEntry[]>,
): Promise<PendingApprovalEntry> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const list = await listPending();
    const match = (list ?? []).find(
      (entry) =>
        entry.request.sessionKey === "agent:main:main" &&
        entry.request.agentId === "main" &&
        entry.request.command?.startsWith("terminal:"),
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  throw new Error("terminal approval never appeared in the gateway approval list");
}

function makeBackend() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pid: 4242,
    write: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    kill: () => undefined,
    onData: (listener: (data: string) => void) => {
      onData = listener;
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      onExit = listener;
    },
    emitData: (data: string) => onData?.(data),
    emitExit: (code: number) => onExit?.({ exitCode: code }),
  };
}

async function writeTempExecConfig(params: {
  workspaceDir: string;
  port: number;
  exec: Record<string, unknown>;
}): Promise<{ stateDir: string; configPath: string }> {
  const stateDir = path.join(path.dirname(params.workspaceDir), ".openclaw");
  await fs.mkdir(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          port: params.port,
          auth: { mode: "token", token: "terminal-e2e-token" },
        },
        tools: { exec: params.exec },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { stateDir, configPath };
}

describe("terminal exec-policy enforcement", () => {
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
    "blocks the terminal open when exec policy denies host execution",
    async () => {
      const envSnapshot = captureEnv(TEST_ENV_KEYS);
      cleanup.push(() => envSnapshot.restore());

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-deny-e2e-"));
      cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));
      const workspaceDir = path.join(tempHome, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const { stateDir, configPath } = await writeTempExecConfig({
        workspaceDir,
        port: 1,
        exec: { mode: "deny" },
      });

      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
      setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
      setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
      clearRuntimeConfigSnapshot();
      clearConfigCache();

      const spawn = async () => makeBackend();
      const manager = new TerminalSessionManager({ emit: () => undefined, spawn });
      const denyConfig: OpenClawConfig = { tools: { exec: { mode: "deny" } } };
      const context = {
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: true as const,
          plan: {
            agentId: "main",
            cwd: workspaceDir,
            shell: "/bin/sh",
            args: [],
          },
        }),
        getRuntimeConfig: () => denyConfig,
      };
      const tool = createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:main",
        sessionId: "main-session-id",
        getGatewayContext: () => context,
      });

      await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
        "exec policy denies host command execution",
      );
      expect(manager.size).toBe(0);
    },
    TERMINAL_E2E_TIMEOUT_MS,
  );

  it(
    "opens a terminal only after an operator grants the allow-once exec approval",
    async () => {
      const envSnapshot = captureEnv(TEST_ENV_KEYS);
      cleanup.push(() => envSnapshot.restore());

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-ask-e2e-"));
      cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));
      const workspaceDir = path.join(tempHome, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const port = await getGatewayE2ePortBlock();
      const token = "terminal-e2e-token";
      const runtimeConfig: OpenClawConfig = {
        gateway: {
          port,
          auth: { mode: "token", token },
        },
        tools: { exec: { host: "gateway", security: "allowlist", ask: "always" } },
      };
      const { stateDir, configPath } = await writeTempExecConfig({
        workspaceDir,
        port,
        exec: { host: "gateway", security: "allowlist", ask: "always" },
      });
      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
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
        clientDisplayName: "terminal approval operator",
        mode: GATEWAY_CLIENT_MODES.TEST,
        scopes: [ADMIN_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        requestTimeoutMs: 200_000,
        timeoutMs: 200_000,
      });
      cleanup.push(() => disconnectGatewayClient(operator));

      const manager = new TerminalSessionManager({
        emit: () => undefined,
        spawn: async () => makeBackend(),
      });
      const context = {
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: true as const,
          plan: {
            agentId: "main",
            cwd: workspaceDir,
            shell: "/bin/sh",
            args: [],
          },
        }),
        getRuntimeConfig: () => runtimeConfig,
      };
      const tool = createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:main",
        sessionId: "main-session-id",
        getGatewayContext: () => context,
      });

      const opening = tool.execute("open", { action: "open" });

      const pending = await withTimeout(
        waitForPendingTerminalApproval(() =>
          operator.request<PendingApprovalEntry[]>("exec.approval.list", {}, { timeoutMs: 10_000 }),
        ),
        60_000,
        { message: "timed out waiting for the terminal approval request" },
      );

      expect(pending.request.command).toContain("/bin/sh");
      await operator.request(
        "exec.approval.resolve",
        { id: pending.id, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      const opened = await withTimeout(opening, 30_000, {
        message: "timed out waiting for the approved terminal open",
      });
      expect(opened.details).toMatchObject({ ok: true });
      expect(manager.size).toBe(1);
    },
    TERMINAL_E2E_TIMEOUT_MS,
  );
});

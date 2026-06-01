import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { isSpawnAcpAcceptedResult, spawnAcpDirect } from "../agents/acp-spawn.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { sleep } from "../utils.js";
import { startGatewayServer } from "./server.js";

const LIVE = isLiveTestEnabled();
const ACP_SPAWN_DEFAULTS_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS);
const describeLive = LIVE && ACP_SPAWN_DEFAULTS_LIVE ? describe : describe.skip;
const CONNECT_TIMEOUT_MS = resolvePositiveInteger(
  process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_CONNECT_TIMEOUT_MS,
  90_000,
);
const LIVE_TIMEOUT_MS = resolvePositiveInteger(
  process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_TIMEOUT_MS,
  240_000,
);

function resolvePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveSubagentModel(): string {
  return process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_MODEL?.trim() || "openai/gpt-5.5";
}

function resolveThinking(): string {
  return process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_THINKING?.trim() || "high";
}

function resolveHarnessModel(): string {
  return process.env.OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL?.trim() || "gpt-5.5";
}

function resolveAcpAgentId(): string {
  return process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_AGENT?.trim() || "codex";
}

function resolveAcpAgentCommand(): { command: string; args?: string[] } {
  const codexHome = process.env.CODEX_HOME?.trim();
  return {
    command: "env",
    args: [
      ...(codexHome ? [`CODEX_HOME=${codexHome}`] : []),
      process.execPath,
      path.join(process.cwd(), "node_modules/@zed-industries/codex-acp/bin/codex-acp.js"),
    ],
  };
}

async function prepareCodexHomeForLiveSpawnDefaultsTest(tempRoot: string): Promise<void> {
  const home = process.env.HOME?.trim();
  const sourceCodexHome = process.env.CODEX_HOME?.trim() || (home ? path.join(home, ".codex") : "");
  const codexHome = path.join(tempRoot, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  if (sourceCodexHome) {
    await fs
      .copyFile(path.join(sourceCodexHome, "auth.json"), path.join(codexHome, "auth.json"))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw error;
        }
      });
  }
  const sourceConfigPath = sourceCodexHome ? path.join(sourceCodexHome, "config.toml") : "";
  const targetConfigPath = path.join(codexHome, "config.toml");
  let rawConfig = "";
  try {
    rawConfig = sourceConfigPath ? await fs.readFile(sourceConfigPath, "utf8") : "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  const modelLine = `model = ${JSON.stringify(resolveHarnessModel())}`;
  const nextConfig = /^model\s*=.*$/m.test(rawConfig)
    ? rawConfig.replace(/^model\s*=.*$/m, modelLine)
    : `${modelLine}\n${rawConfig}`;
  await fs.writeFile(targetConfigPath, nextConfig, "utf8");
  process.env.CODEX_HOME = codexHome;
}

async function waitForGatewayPort(params: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: params.host, port: params.port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (connected) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for gateway port ${params.host}:${String(params.port)}`);
}

async function getFreeGatewayPort(): Promise<number> {
  const { getFreePortBlockWithPermissionFallback } = await import("../test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 42_000,
  });
}

async function waitForAcpBackendReady(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const backend = getAcpRuntimeBackend("acpx");
    const runtime = backend?.runtime as { probeAvailability?: () => Promise<void> } | undefined;
    if (backend && (!backend.healthy || backend.healthy())) {
      return;
    }
    await runtime?.probeAvailability?.().catch(() => {});
    if (backend && (!backend.healthy || backend.healthy())) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error("timed out waiting for acpx backend readiness");
}

async function waitForSessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  timeoutMs?: number;
}): Promise<SessionEntry> {
  const timeoutMs = params.timeoutMs ?? 20_000;
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: "codex" });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const entry = loadSessionStore(storePath)[params.sessionKey];
    if (entry) {
      return entry;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ACP session entry ${params.sessionKey}`);
}

function createConfig(params: {
  port: number;
  tempRoot: string;
  acpAgentId: string;
  subagentModel?: string;
  thinking?: string;
  includePrimaryOnlyAcpAgent?: boolean;
}): OpenClawConfig {
  const subagents = params.subagentModel
    ? {
        allowAgents: ["*"],
        maxSpawnDepth: 2,
        model: params.subagentModel,
      }
    : {
        allowAgents: ["*"],
        maxSpawnDepth: 2,
      };

  return {
    agents: {
      list: params.includePrimaryOnlyAcpAgent
        ? [
            {
              id: "codex-acp-primary-only",
              runtime: {
                type: "acp",
                acp: { agent: params.acpAgentId },
              },
              model: "anthropic/claude-sonnet-4-6",
            },
          ]
        : undefined,
      defaults: {
        model: {
          primary: "openai/gpt-5.5",
        },
        subagents,
        models:
          params.subagentModel && params.thinking
            ? {
                [params.subagentModel]: {
                  params: {
                    thinking: params.thinking,
                  },
                },
              }
            : {},
      },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port: params.port,
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
      store: path.join(params.tempRoot, "sessions.json"),
    },
    acp: {
      enabled: true,
      backend: "acpx",
      defaultAgent: params.acpAgentId,
      allowedAgents: [params.acpAgentId],
    },
    plugins: {
      enabled: true,
      allow: ["acpx"],
      entries: {
        acpx: {
          enabled: true,
          config: {
            probeAgent: params.acpAgentId,
            permissionMode: "approve-all",
            nonInteractivePermissions: "deny",
            agents: {
              [params.acpAgentId]: resolveAcpAgentCommand(),
            },
          },
        },
      },
    },
  };
}

describeLive("gateway live (ACP spawn defaults)", () => {
  it(
    "applies existing subagent defaults to live ACP spawns without leaking primary agent model",
    async () => {
      const previous = {
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        stateDir: process.env.OPENCLAW_STATE_DIR,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        port: process.env.OPENCLAW_GATEWAY_PORT,
        skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
        skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
        skipCron: process.env.OPENCLAW_SKIP_CRON,
        skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
        codexHome: process.env.CODEX_HOME,
      };
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-acp-spawn-"));
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const tempStateDir = path.join(tempRoot, "state");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const acpAgentId = resolveAcpAgentId();
      const subagentModel = resolveSubagentModel();
      const thinking = resolveThinking();
      const sessionKeys: string[] = [];

      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      await prepareCodexHomeForLiveSpawnDefaultsTest(tempRoot);

      const cfg = createConfig({
        port,
        tempRoot,
        acpAgentId,
        subagentModel,
        thinking,
        includePrimaryOnlyAcpAgent: true,
      });
      await fs.writeFile(tempConfigPath, `${JSON.stringify(cfg, null, 2)}\n`);
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      clearPluginLoaderCache();
      resetPluginRuntimeStateForTest();

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      try {
        await waitForGatewayPort({ host: "127.0.0.1", port, timeoutMs: CONNECT_TIMEOUT_MS });
        await waitForAcpBackendReady();
        const runtimeCfg = getRuntimeConfig();
        const configuredDefaultResult = await spawnAcpDirect(
          {
            task: "Reply with exactly LIVE-ACP-SPAWN-DEFAULTS-OK",
            agentId: acpAgentId,
            mode: "run",
          },
          { agentSessionKey: "agent:main:main" },
        );
        if (!isSpawnAcpAcceptedResult(configuredDefaultResult)) {
          throw new Error(
            `configured default ACP spawn failed (${configuredDefaultResult.errorCode}): ${configuredDefaultResult.error}`,
          );
        }
        expect(isSpawnAcpAcceptedResult(configuredDefaultResult)).toBe(true);
        sessionKeys.push(configuredDefaultResult.childSessionKey);
        const configuredDefaultEntry = await waitForSessionEntry({
          cfg: runtimeCfg,
          sessionKey: configuredDefaultResult.childSessionKey,
        });
        expect(configuredDefaultEntry.acp?.runtimeOptions).toMatchObject({
          model: subagentModel,
          thinking,
        });

        const primaryOnlyResult = await spawnAcpDirect(
          {
            task: "Reply with exactly LIVE-ACP-SPAWN-PRIMARY-DEFAULT-OK",
            agentId: "codex-acp-primary-only",
            mode: "run",
          },
          { agentSessionKey: "agent:main:main" },
        );
        if (!isSpawnAcpAcceptedResult(primaryOnlyResult)) {
          throw new Error(
            `primary-only ACP spawn failed (${primaryOnlyResult.errorCode}): ${primaryOnlyResult.error}`,
          );
        }
        expect(isSpawnAcpAcceptedResult(primaryOnlyResult)).toBe(true);
        sessionKeys.push(primaryOnlyResult.childSessionKey);
        const primaryOnlyEntry = await waitForSessionEntry({
          cfg: runtimeCfg,
          sessionKey: primaryOnlyResult.childSessionKey,
        });
        expect(primaryOnlyEntry.acp?.runtimeOptions).toMatchObject({
          model: subagentModel,
          thinking,
        });
        expect(primaryOnlyEntry.acp?.runtimeOptions?.model).not.toBe("anthropic/claude-sonnet-4-6");
      } finally {
        const runtimeCfg = getRuntimeConfig();
        for (const sessionKey of sessionKeys) {
          await getAcpSessionManager()
            .closeSession({
              cfg: runtimeCfg,
              sessionKey,
              reason: "live-acp-spawn-defaults-test-cleanup",
              discardPersistentState: true,
              clearMeta: true,
              requireAcpSession: false,
            })
            .catch(() => {});
        }
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        await server.close();
        await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (previous.configPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = previous.configPath;
        }
        if (previous.stateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previous.stateDir;
        }
        if (previous.token === undefined) {
          delete process.env.OPENCLAW_GATEWAY_TOKEN;
        } else {
          process.env.OPENCLAW_GATEWAY_TOKEN = previous.token;
        }
        if (previous.port === undefined) {
          delete process.env.OPENCLAW_GATEWAY_PORT;
        } else {
          process.env.OPENCLAW_GATEWAY_PORT = previous.port;
        }
        if (previous.skipChannels === undefined) {
          delete process.env.OPENCLAW_SKIP_CHANNELS;
        } else {
          process.env.OPENCLAW_SKIP_CHANNELS = previous.skipChannels;
        }
        if (previous.skipGmail === undefined) {
          delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
        } else {
          process.env.OPENCLAW_SKIP_GMAIL_WATCHER = previous.skipGmail;
        }
        if (previous.skipCron === undefined) {
          delete process.env.OPENCLAW_SKIP_CRON;
        } else {
          process.env.OPENCLAW_SKIP_CRON = previous.skipCron;
        }
        if (previous.skipCanvas === undefined) {
          delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
        } else {
          process.env.OPENCLAW_SKIP_CANVAS_HOST = previous.skipCanvas;
        }
        if (previous.codexHome === undefined) {
          delete process.env.CODEX_HOME;
        } else {
          process.env.CODEX_HOME = previous.codexHome;
        }
      }
    },
    LIVE_TIMEOUT_MS + 120_000,
  );
});

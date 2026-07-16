/**
 * Live tests for default ACP spawn settings used by gateway sessions.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
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
import { clearPluginLoaderCache } from "../plugins/loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { sleep } from "../utils.js";
import { restoreLiveEnv, snapshotLiveEnv, type LiveEnvSnapshot } from "./live-env-test-helpers.js";
import { startGatewayServer } from "./server.js";

const LIVE = isLiveTestEnabled();
const ACP_SPAWN_DEFAULTS_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS);
const ACP_THINKING_CONTROLS_LIVE = isTruthyEnvValue(
  process.env.OPENCLAW_LIVE_ACP_THINKING_CONTROLS,
);
const describeLive = LIVE && ACP_SPAWN_DEFAULTS_LIVE ? describe : describe.skip;
const CONNECT_TIMEOUT_MS = resolvePositiveInteger(
  process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_CONNECT_TIMEOUT_MS,
  90_000,
);
const LIVE_TIMEOUT_MS = resolvePositiveInteger(
  process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_TIMEOUT_MS,
  240_000,
);

function snapshotAcpSpawnDefaultsLiveEnv(): LiveEnvSnapshot {
  return snapshotLiveEnv(["CODEX_HOME", "OPENCLAW_GATEWAY_PORT"]);
}

function resolvePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveSubagentModel(): string {
  return process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_MODEL?.trim() || "openai/gpt-5.6-luna";
}

function resolveThinking(): string {
  return process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_THINKING?.trim() || "high";
}

function resolveHarnessReasoningEffort(): string | undefined {
  const thinking = resolveThinking().toLowerCase();
  if (thinking === "off") {
    return undefined;
  }
  if (thinking === "minimal") {
    return "low";
  }
  if (thinking === "x-high") {
    return "xhigh";
  }
  return thinking;
}

function resolveHarnessBaselineReasoningEffort(): string {
  return resolveHarnessReasoningEffort() === "low" ? "medium" : "low";
}

function findRuntimeConfigOption(status: unknown, id: string): Record<string, unknown> | undefined {
  const statusRecord = asNullableRecord(status);
  const details = asNullableRecord(statusRecord?.details);
  const configOptions = details?.configOptions;
  if (!Array.isArray(configOptions)) {
    return undefined;
  }
  return (
    configOptions.map((option) => asNullableRecord(option)).find((option) => option?.id === id) ??
    undefined
  );
}

function resolveHarnessModel(): string {
  return process.env.OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL?.trim() || "gpt-5.6-luna";
}

function resolveAcpAgentId(): string {
  return process.env.OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS_AGENT?.trim() || "codex";
}

function resolveAcpAgentCommand(agentId: string): { command: string; args?: string[] } {
  if (agentId === "opencode") {
    return { command: "opencode", args: ["acp"] };
  }
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
  let nextConfig = /^model\s*=.*$/m.test(rawConfig)
    ? rawConfig.replace(/^model\s*=.*$/m, modelLine)
    : `${modelLine}\n${rawConfig}`;
  const baselineReasoningEffort = resolveHarnessBaselineReasoningEffort();
  const reasoningLine = `model_reasoning_effort = ${JSON.stringify(baselineReasoningEffort)}`;
  nextConfig = /^model_reasoning_effort\s*=.*$/m.test(nextConfig)
    ? nextConfig.replace(/^model_reasoning_effort\s*=.*$/m, reasoningLine)
    : `${reasoningLine}\n${nextConfig}`;
  const planReasoningLine = `plan_mode_reasoning_effort = ${JSON.stringify(baselineReasoningEffort)}`;
  nextConfig = /^plan_mode_reasoning_effort\s*=.*$/m.test(nextConfig)
    ? nextConfig.replace(/^plan_mode_reasoning_effort\s*=.*$/m, planReasoningLine)
    : `${planReasoningLine}\n${nextConfig}`;
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

async function runOpenCodeThinkingControlProof(params: {
  cfg: OpenClawConfig;
  model: string;
  thinking: string;
  sessionKeys: string[];
}): Promise<void> {
  const sessionKey = `agent:opencode:acp:${randomUUID()}`;
  const manager = getAcpSessionManager();
  await manager.initializeSession({
    cfg: params.cfg,
    sessionKey,
    agent: "opencode",
    mode: "persistent",
    runtimeOptions: {
      model: params.model,
      thinking: params.thinking,
    },
  });
  params.sessionKeys.push(sessionKey);

  await manager.runTurn({
    cfg: params.cfg,
    sessionKey,
    provenance: "system",
    text: "Reply with exactly LIVE-ACP-SPAWN-DEFAULTS-OK",
    mode: "prompt",
    requestId: randomUUID(),
  });
  const status = await manager.getSessionStatus({ cfg: params.cfg, sessionKey });
  expect(status.runtimeOptions).toMatchObject({
    model: params.model,
    thinking: params.thinking,
  });
  expect(status.capabilities.configOptionKeys).toEqual(expect.arrayContaining(["mode", "model"]));
  for (const key of ["thinking", "effort", "reasoning_effort", "thought_level"]) {
    expect(status.capabilities.configOptionKeys).not.toContain(key);
  }
  await expect(
    manager.setSessionConfigOption({
      cfg: params.cfg,
      sessionKey,
      key: "thinking",
      value: params.thinking,
    }),
  ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
  console.info(
    "[live-acp-spawn-defaults] opencode automatic thinking skipped; explicit write rejected",
  );
}

async function runCodexThinkingControlProof(params: {
  cfg: OpenClawConfig;
  model: string;
  thinking: string;
  sessionKeys: string[];
}): Promise<void> {
  const sessionKey = `agent:codex:acp:${randomUUID()}`;
  const manager = getAcpSessionManager();
  const baselineReasoningEffort = resolveHarnessBaselineReasoningEffort();
  await manager.initializeSession({
    cfg: params.cfg,
    sessionKey,
    agent: "codex",
    mode: "persistent",
    runtimeOptions: {
      model: params.model,
      thinking: baselineReasoningEffort,
    },
  });
  params.sessionKeys.push(sessionKey);

  await manager.runTurn({
    cfg: params.cfg,
    sessionKey,
    provenance: "system",
    text: "Reply with exactly LIVE-ACP-SPAWN-DEFAULTS-OK",
    mode: "prompt",
    requestId: randomUUID(),
  });
  const initialStatus = await manager.getSessionStatus({ cfg: params.cfg, sessionKey });
  const initialReasoningEffortOption = findRuntimeConfigOption(
    initialStatus.runtimeStatus,
    "reasoning_effort",
  );
  expect(initialReasoningEffortOption).toEqual(
    expect.objectContaining({ currentValue: baselineReasoningEffort }),
  );

  await manager.updateSessionRuntimeOptions({
    cfg: params.cfg,
    sessionKey,
    patch: { thinking: params.thinking },
  });
  await manager.runTurn({
    cfg: params.cfg,
    sessionKey,
    provenance: "system",
    text: "Reply with exactly LIVE-ACP-SPAWN-DEFAULTS-OK",
    mode: "prompt",
    requestId: randomUUID(),
  });
  const status = await manager.getSessionStatus({ cfg: params.cfg, sessionKey });
  expect(status.capabilities.configOptionKeys).toContain("reasoning_effort");
  const expectedReasoningEffort = resolveHarnessReasoningEffort();
  const reasoningEffortOption = findRuntimeConfigOption(status.runtimeStatus, "reasoning_effort");
  expect(reasoningEffortOption).toBeDefined();
  if (expectedReasoningEffort) {
    expect(reasoningEffortOption).toEqual(
      expect.objectContaining({ currentValue: expectedReasoningEffort }),
    );
  } else {
    // Codex ACP has no disabled effort value. `off` means leave its model default untouched.
    expect(reasoningEffortOption?.currentValue).toBe(baselineReasoningEffort);
  }
  console.info(`[live-acp-spawn-defaults] codex reasoning_effort=${params.thinking} confirmed`);
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
            permissionMode: "approve-all",
            nonInteractivePermissions: "deny",
            agents: {
              [params.acpAgentId]: resolveAcpAgentCommand(params.acpAgentId),
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
      const previousEnv = snapshotAcpSpawnDefaultsLiveEnv();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-acp-spawn-"));
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const tempStateDir = path.join(tempRoot, "state");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const acpAgentId = resolveAcpAgentId();
      const subagentModel = resolveSubagentModel();
      const thinking = resolveThinking();
      const sessionKeys: string[] = [];
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

      setTestEnvValue("OPENCLAW_CONFIG_PATH", tempConfigPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      if (acpAgentId === "codex") {
        await prepareCodexHomeForLiveSpawnDefaultsTest(tempRoot);
      }

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

      try {
        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        await waitForGatewayPort({ host: "127.0.0.1", port, timeoutMs: CONNECT_TIMEOUT_MS });
        await waitForAcpBackendReady();
        const runtimeCfg = getRuntimeConfig();
        if (ACP_THINKING_CONTROLS_LIVE) {
          const runProof =
            acpAgentId === "opencode"
              ? runOpenCodeThinkingControlProof
              : runCodexThinkingControlProof;
          await runProof({ cfg: runtimeCfg, model: subagentModel, thinking, sessionKeys });
          return;
        }
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
        try {
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
          await server?.close();
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          restoreLiveEnv(previousEnv);
        }
      }
    },
    LIVE_TIMEOUT_MS + 120_000,
  );
});

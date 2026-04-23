import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { clearConfigCache, clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { sleep } from "../utils.js";
import type { GatewayClient } from "./client.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import {
  assertCronJobMatches,
  assertCronJobVisibleViaCli,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  runOpenClawCliJson,
} from "./live-agent-probes.js";
import { renderCatFacePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";

const LIVE = isLiveTestEnabled();
const ACP_BIND_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_ACP_BIND);
const describeLive = LIVE && ACP_BIND_LIVE ? describe : describe.skip;

const CONNECT_TIMEOUT_MS = 90_000;
const LIVE_TIMEOUT_MS = 240_000;
const DEFAULT_LIVE_CODEX_MODEL = "gpt-5.4";
type LiveAcpAgent = "claude" | "codex" | "gemini";

function createSlackCurrentConversationBindingRegistry() {
  return createTestRegistry([
    {
      pluginId: "slack",
      source: "test",
      plugin: {
        id: "slack",
        meta: {
          id: "slack",
          label: "Slack",
          selectionLabel: "Slack",
          docsPath: "/channels/slack",
          blurb: "test stub.",
          aliases: [],
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        conversationBindings: {
          supportsCurrentConversationBinding: true,
        },
      },
    },
  ]);
}

function normalizeAcpAgent(raw: string | undefined): LiveAcpAgent {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "gemini") {
    return "gemini";
  }
  if (normalized === "codex") {
    return "codex";
  }
  return "claude";
}

function extractAssistantTexts(messages: unknown[]): string[] {
  return messages
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const role = (entry as { role?: unknown }).role;
      if (role !== "assistant") {
        return undefined;
      }
      return extractFirstTextBlock(entry);
    })
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function createAcpRecallPrompt(liveAgent: LiveAcpAgent): string {
  if (liveAgent !== "claude") {
    return "Please include the exact token from your immediately previous assistant reply.";
  }
  return "Reply with exactly the token from your immediately previous assistant reply and nothing else.";
}

function createAcpMarkerPrompt(liveAgent: LiveAcpAgent, memoryNonce: string): string {
  const token = `ACP-BIND-MEMORY-${memoryNonce}`;
  if (liveAgent !== "claude") {
    return `Please include the exact token ${token} in your reply.`;
  }
  return `Reply with exactly this token and nothing else: ${token}`;
}

function extractSpawnedAcpSessionKey(texts: string[]): string | null {
  for (const text of texts) {
    const match = text.match(/Spawned ACP session (\S+) \(/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

async function getFreeGatewayPort(): Promise<number> {
  const { getFreePortBlockWithPermissionFallback } = await import("../test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 41_000,
  });
}

function logLiveStep(message: string): void {
  console.info(`[live-acp-bind] ${message}`);
}

async function prepareCodexHomeForLiveBindTest(): Promise<void> {
  const home = process.env.HOME?.trim();
  if (!home) {
    return;
  }
  const model = process.env.OPENCLAW_LIVE_ACP_BIND_CODEX_MODEL?.trim() || DEFAULT_LIVE_CODEX_MODEL;
  const codexHome = path.join(home, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  let rawConfig = "";
  try {
    rawConfig = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  const modelLine = `model = ${JSON.stringify(model)}`;
  const nextConfig = /^model\s*=.*$/m.test(rawConfig)
    ? rawConfig.replace(/^model\s*=.*$/m, modelLine)
    : `${modelLine}\n${rawConfig}`;
  await fs.writeFile(configPath, nextConfig, "utf8");
  process.env.CODEX_HOME = codexHome;
  logLiveStep(`using Codex ACP model ${model}`);
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
      const socket = net.createConnection({
        host: params.host,
        port: params.port,
      });
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

async function connectClient(params: { url: string; token: string; timeoutMs?: number }) {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return await connectTestGatewayClient({
    ...params,
    timeoutMs,
    maxAttemptTimeoutMs: 35_000,
    clientDisplayName: null,
    requestTimeoutMs: timeoutMs,
    onRetry: (attempt, error) => {
      logLiveStep(`gateway connect warmup retry ${attempt}: ${error.message}`);
    },
  });
}

function isRetryableAcpBindWarmupText(texts: string[]): boolean {
  const combined = texts.join("\n\n").toLowerCase();
  return (
    combined.includes("acp runtime backend is currently unavailable") ||
    combined.includes("try again in a moment") ||
    combined.includes("acp runtime backend is not configured") ||
    combined.includes("acp dispatch is disabled")
  );
}

function formatAssistantTextPreview(texts: string[], maxChars = 600): string {
  const combined = texts.join("\n\n").trim();
  if (!combined) {
    return "<empty>";
  }
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(-maxChars);
}

function findAssistantTextContaining(texts: string[], needle: string): string | null {
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const text = texts[i];
    if (text?.includes(needle)) {
      return text;
    }
  }
  return null;
}

async function bindConversationAndWait(params: {
  client: GatewayClient;
  sessionKey: string;
  liveAgent: LiveAcpAgent;
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId: string;
  timeoutMs?: number;
}): Promise<{ mainAssistantTexts: string[]; spawnedSessionKey: string }> {
  const timeoutMs = params.timeoutMs ?? LIVE_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const backend = getAcpRuntimeBackend("acpx");
    const runtime = backend?.runtime as
      | {
          probeAvailability?: () => Promise<void>;
          doctor?: () => Promise<{ message?: string; details?: string[] }>;
        }
      | undefined;
    if (runtime?.probeAvailability) {
      await runtime.probeAvailability().catch(() => {});
    }
    if (!(backend?.healthy?.() ?? false)) {
      if (runtime?.doctor && (attempt === 1 || attempt % 6 === 0)) {
        const report = await runtime.doctor().catch((error) => ({
          message: error instanceof Error ? error.message : String(error),
          details: [],
        }));
        logLiveStep(
          `acpx doctor before bind attempt ${attempt}: ${report.message ?? "unknown"}${
            report.details?.length ? ` (${report.details.join("; ")})` : ""
          }`,
        );
      }
      logLiveStep(`acpx backend still unhealthy before bind attempt ${attempt}`);
      await sleep(5_000);
      continue;
    }

    await sendChatAndWait({
      client: params.client,
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-bind-${randomUUID()}`,
      message: `/acp spawn ${params.liveAgent} --bind here`,
      originatingChannel: params.originatingChannel,
      originatingTo: params.originatingTo,
      originatingAccountId: params.originatingAccountId,
    });

    const mainHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const mainAssistantTexts = extractAssistantTexts(mainHistory.messages ?? []);
    const spawnedSessionKey = extractSpawnedAcpSessionKey(mainAssistantTexts);
    if (
      mainAssistantTexts.join("\n\n").includes("Bound this conversation to") &&
      spawnedSessionKey
    ) {
      return { mainAssistantTexts, spawnedSessionKey };
    }
    if (!isRetryableAcpBindWarmupText(mainAssistantTexts)) {
      throw new Error(
        `bind command did not produce an ACP session: ${formatAssistantTextPreview(mainAssistantTexts)}`,
      );
    }
    logLiveStep(`acpx backend still warming up; retrying bind (${attempt})`);
    await sleep(5_000);
  }

  throw new Error("timed out waiting for the ACP bind command to succeed");
}

async function waitForAgentRunOk(
  client: GatewayClient,
  runId: string,
  timeoutMs = LIVE_TIMEOUT_MS,
) {
  const result: { status?: string } = await client.request(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  );
  if (result?.status !== "ok") {
    throw new Error(`agent.wait failed for ${runId}: status=${String(result?.status)}`);
  }
}

async function sendChatAndWait(params: {
  client: GatewayClient;
  sessionKey: string;
  idempotencyKey: string;
  message: string;
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId: string;
  attachments?: Array<{
    mimeType: string;
    fileName: string;
    content: string;
  }>;
}) {
  const started: { runId?: string; status?: string } = await params.client.request("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    attachments: params.attachments,
  });
  if (started?.status !== "started" || typeof started.runId !== "string") {
    throw new Error(`chat.send did not start correctly: ${JSON.stringify(started)}`);
  }
  await waitForAgentRunOk(params.client, started.runId);
}

async function waitForAssistantText(params: {
  client: GatewayClient;
  sessionKey: string;
  contains: string;
  minAssistantCount?: number;
  timeoutMs?: number;
}): Promise<{ messages: unknown[]; lastAssistantText: string; matchedAssistantText: string }> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const messages = history.messages ?? [];
    const assistantTexts = extractAssistantTexts(messages);
    const lastAssistantText = assistantTexts.at(-1) ?? "";
    const matchedAssistantText = findAssistantTextContaining(assistantTexts, params.contains);
    if (assistantTexts.length >= (params.minAssistantCount ?? 1) && matchedAssistantText) {
      return { messages, lastAssistantText, matchedAssistantText };
    }
    await sleep(500);
  }

  const finalHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: params.sessionKey,
    limit: 16,
  });
  throw new Error(
    `timed out waiting for assistant text containing ${params.contains}: ${formatAssistantTextPreview(
      extractAssistantTexts(finalHistory.messages ?? []),
    )}`,
  );
}

async function waitForAssistantTurn(params: {
  client: GatewayClient;
  sessionKey: string;
  minAssistantCount: number;
  timeoutMs?: number;
}): Promise<{ messages: unknown[]; lastAssistantText: string }> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 16,
    });
    const messages = history.messages ?? [];
    const assistantTexts = extractAssistantTexts(messages);
    const lastAssistantText = assistantTexts.at(-1) ?? null;
    if (assistantTexts.length >= params.minAssistantCount && lastAssistantText) {
      return { messages, lastAssistantText };
    }
    await sleep(500);
  }

  const finalHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: params.sessionKey,
    limit: 16,
  });
  throw new Error(
    `timed out waiting for assistant turn ${String(params.minAssistantCount)}: ${formatAssistantTextPreview(
      extractAssistantTexts(finalHistory.messages ?? []),
    )}`,
  );
}

describeLive("gateway live (ACP bind)", () => {
  it(
    "binds a synthetic Slack DM conversation to a live ACP session and reroutes the next turn",
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
      const liveAgent = normalizeAcpAgent(process.env.OPENCLAW_LIVE_ACP_BIND_AGENT);
      const agentCommandOverride =
        process.env.OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND?.trim() || undefined;
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-acp-bind-"));
      const tempStateDir = path.join(tempRoot, "state");
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const originalSessionKey = "main";
      const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const conversationId = `user:${slackUserId}`;
      const accountId = "default";
      const followupNonce = randomBytes(4).toString("hex").toUpperCase();
      const memoryNonce = randomBytes(4).toString("hex").toUpperCase();

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_SKIP_CRON = "0";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      if (liveAgent === "codex" && !agentCommandOverride) {
        await prepareCodexHomeForLiveBindTest();
      }

      const cfg = loadConfig();
      const acpxEntry = cfg.plugins?.entries?.acpx;
      const existingAgentOverrides: Record<string, { command?: string }> =
        typeof acpxEntry?.config === "object" &&
        acpxEntry.config &&
        typeof acpxEntry.config.agents === "object" &&
        acpxEntry.config.agents
          ? (acpxEntry.config.agents as Record<string, { command?: string }>)
          : {};
      const nextCfg = {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          mode: "local",
          bind: "loopback",
          port,
        },
        acp: {
          ...cfg.acp,
          enabled: true,
          backend: "acpx",
          defaultAgent: liveAgent,
          allowedAgents: Array.from(new Set([...(cfg.acp?.allowedAgents ?? []), liveAgent])),
          dispatch: {
            ...cfg.acp?.dispatch,
            enabled: true,
          },
        },
        plugins: {
          ...cfg.plugins,
          enabled: true,
          allow: Array.from(new Set([...(cfg.plugins?.allow ?? []), "acpx"])),
          entries: {
            ...cfg.plugins?.entries,
            acpx: {
              ...acpxEntry,
              enabled: true,
              config: {
                ...acpxEntry?.config,
                probeAgent: liveAgent,
                permissionMode: "approve-all",
                nonInteractivePermissions: "deny",
                openClawToolsMcpBridge: true,
                ...(agentCommandOverride
                  ? {
                      agents: {
                        ...existingAgentOverrides,
                        [liveAgent]: {
                          command: agentCommandOverride,
                        },
                      },
                    }
                  : {}),
              },
            },
          },
        },
        cron: {
          ...cfg.cron,
          enabled: true,
          store: path.join(tempRoot, "cron.json"),
        },
      };
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      clearPluginLoaderCache();
      resetPluginRuntimeStateForTest();

      logLiveStep(`starting gateway on port ${String(port)}`);
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        awaitStartupSidecars: true,
      });
      logLiveStep("gateway startup returned");
      await waitForGatewayPort({ host: "127.0.0.1", port, timeoutMs: CONNECT_TIMEOUT_MS });
      logLiveStep("gateway port is reachable");
      const client = await connectClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      logLiveStep("gateway websocket connected");
      const channelRegistry = createSlackCurrentConversationBindingRegistry();
      pinActivePluginChannelRegistry(channelRegistry);

      try {
        const { mainAssistantTexts, spawnedSessionKey } = await bindConversationAndWait({
          client,
          sessionKey: originalSessionKey,
          liveAgent,
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
        });
        logLiveStep("bind command completed");
        expect(mainAssistantTexts.join("\n\n")).toContain("Bound this conversation to");
        expect(spawnedSessionKey).toMatch(new RegExp(`^agent:${liveAgent}:acp:`));
        logLiveStep(`binding announced for session ${spawnedSessionKey ?? "missing"}`);

        const followupToken = `ACP-BIND-${followupNonce}`;
        let firstBoundHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
        for (let attempt = 0; attempt < 3 && !firstBoundHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-followup-${attempt}-${randomUUID()}`,
            message: `Reply with exactly this token and nothing else: ${followupToken}`,
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`follow-up turn completed (attempt ${String(attempt + 1)})`);
          try {
            firstBoundHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              contains: followupToken,
              timeoutMs: 60_000,
            });
          } catch (error) {
            if (attempt === 2) {
              throw error;
            }
            logLiveStep("bound follow-up token not observed yet; retrying");
          }
        }
        if (!firstBoundHistory) {
          throw new Error(`bound follow-up token missing after retries (${followupToken})`);
        }
        const firstAssistantCount = extractAssistantTexts(firstBoundHistory.messages).length;

        let recallHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
        const expectedRecallAssistantCount = firstAssistantCount + 1;
        const maxRecallAttempts = liveAgent === "claude" ? 3 : 1;
        for (let attempt = 0; attempt < maxRecallAttempts && !recallHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-memory-${attempt}-${randomUUID()}`,
            message: createAcpRecallPrompt(liveAgent),
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`memory recall turn completed (attempt ${String(attempt + 1)})`);

          try {
            recallHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              contains: followupToken,
              minAssistantCount: expectedRecallAssistantCount,
              timeoutMs: liveAgent === "claude" ? 60_000 : 25_000,
            });
          } catch (error) {
            if (attempt === maxRecallAttempts - 1) {
              if (liveAgent === "claude") {
                throw error;
              }
              break;
            }
            logLiveStep("bound memory recall token not observed yet; retrying");
          }
        }
        if (!recallHistory) {
          if (liveAgent === "claude") {
            const recallTurn = await waitForAssistantTurn({
              client,
              sessionKey: spawnedSessionKey,
              minAssistantCount: expectedRecallAssistantCount,
              timeoutMs: 60_000,
            });
            recallHistory = {
              messages: recallTurn.messages,
              lastAssistantText: recallTurn.lastAssistantText,
              matchedAssistantText: recallTurn.lastAssistantText,
            };
            logLiveStep(
              "bound memory recall response did not repeat token; using turn progression",
            );
          } else {
            // Non-Claude lanes can miss or significantly delay this intermediate recall turn.
            // Continue from the previously observed bound transcript and validate marker/image/cron
            // on subsequent turns.
            recallHistory = firstBoundHistory;
            logLiveStep(
              "bound memory recall response not observed; continuing from previous bound transcript",
            );
          }
        }
        const recallAssistantText = recallHistory.matchedAssistantText;
        if (liveAgent === "claude") {
          expect(recallAssistantText).toContain(followupToken);
        }
        logLiveStep("bound session transcript retained the previous token");
        const recallAssistantCount = extractAssistantTexts(recallHistory.messages).length;

        let boundHistory: Awaited<ReturnType<typeof waitForAssistantText>> | null = null;
        for (let attempt = 0; attempt < 3 && !boundHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-marker-${attempt}-${randomUUID()}`,
            message: createAcpMarkerPrompt(liveAgent, memoryNonce),
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`memory marker turn completed (attempt ${String(attempt + 1)})`);
          try {
            boundHistory = await waitForAssistantText({
              client,
              sessionKey: spawnedSessionKey,
              contains: `ACP-BIND-MEMORY-${memoryNonce}`,
              minAssistantCount: recallAssistantCount + 1,
            });
          } catch (error) {
            if (attempt === 2) {
              throw error;
            }
            logLiveStep("bound marker token not observed yet; retrying");
          }
        }
        if (!boundHistory) {
          throw new Error(
            `timed out waiting for bound marker token ACP-BIND-MEMORY-${memoryNonce}`,
          );
        }
        const assistantTexts = extractAssistantTexts(boundHistory.messages);
        expect(assistantTexts.join("\n\n")).toContain(followupToken);
        expect(boundHistory.matchedAssistantText).toContain(`ACP-BIND-MEMORY-${memoryNonce}`);
        logLiveStep("bound session transcript contains the final marker token");

        const markerAssistantCount = assistantTexts.length;
        let imageHistory: Awaited<ReturnType<typeof waitForAssistantTurn>> | null = null;
        for (let attempt = 0; attempt < 2 && !imageHistory; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-image-${attempt}-${randomUUID()}`,
            message:
              "Best match for the attached image: lobster, mouse, cat, horse. " +
              "Reply with one lowercase word only.",
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
            attachments: [
              {
                mimeType: "image/png",
                fileName: `probe-${randomUUID()}.png`,
                content: renderCatFacePngBase64(),
              },
            ],
          });
          logLiveStep(`image turn completed (attempt ${String(attempt + 1)})`);

          try {
            imageHistory = await waitForAssistantTurn({
              client,
              sessionKey: spawnedSessionKey,
              minAssistantCount: markerAssistantCount + 1,
              timeoutMs: liveAgent === "claude" ? 60_000 : 45_000,
            });
          } catch (error) {
            if (attempt === 1) {
              if (liveAgent === "claude") {
                throw error;
              }
              logLiveStep(
                "bound session image reply not observed; continuing to cron verification",
              );
              break;
            }
            logLiveStep("bound session image reply not observed yet; retrying");
          }
        }
        if (imageHistory) {
          assertLiveImageProbeReply(imageHistory.lastAssistantText);
          logLiveStep("bound session classified the probe image");
        }

        const imageAssistantCount = imageHistory
          ? extractAssistantTexts(imageHistory.messages).length
          : markerAssistantCount;
        const cronProbe = createLiveCronProbeSpec({
          agentId: liveAgent,
          sessionKey: spawnedSessionKey,
        });
        let cronJobId: string | undefined;
        let lastCronAssistantText = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await sendChatAndWait({
            client,
            sessionKey: originalSessionKey,
            idempotencyKey: `idem-cron-${attempt}-${randomUUID()}`,
            message: buildLiveCronProbeMessage({
              agent: liveAgent,
              argsJson: cronProbe.argsJson,
              attempt,
              exactReply: cronProbe.name,
            }),
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
          });
          logLiveStep(`cron mcp turn completed (attempt ${String(attempt + 1)})`);

          let cronHistory: Awaited<ReturnType<typeof waitForAssistantTurn>> | null = null;
          if (liveAgent === "claude") {
            cronHistory = await waitForAssistantTurn({
              client,
              sessionKey: spawnedSessionKey,
              minAssistantCount: imageAssistantCount + 1,
              timeoutMs: 90_000,
            });
          } else {
            try {
              cronHistory = await waitForAssistantTurn({
                client,
                sessionKey: spawnedSessionKey,
                minAssistantCount: imageAssistantCount + 1,
                timeoutMs: 45_000,
              });
            } catch {
              logLiveStep("cron assistant reply not observed yet; relying on CLI verification");
            }
          }
          if (cronHistory) {
            lastCronAssistantText = cronHistory.lastAssistantText;
          }
          const createdJob = await assertCronJobVisibleViaCli({
            port,
            token,
            env: process.env,
            expectedName: cronProbe.name,
            expectedMessage: cronProbe.message,
          });
          if (createdJob) {
            assertCronJobMatches({
              job: createdJob,
              expectedName: cronProbe.name,
              expectedMessage: cronProbe.message,
              expectedSessionKey: spawnedSessionKey,
              expectedAgentId: liveAgent,
            });
            cronJobId = createdJob.id;
            if (cronHistory) {
              expect(cronHistory.lastAssistantText.trim().length).toBeGreaterThan(0);
            }
            break;
          }
          if (attempt === 1) {
            if (liveAgent !== "claude") {
              logLiveStep(
                `cron mcp job ${cronProbe.name} not observed for ${liveAgent}; continuing after bind/image verification`,
              );
              break;
            }
            throw new Error(
              `acp cron cli verify could not find job ${cronProbe.name}: reply=${JSON.stringify(
                lastCronAssistantText,
              )}`,
            );
          }
        }
        if (!cronJobId) {
          if (liveAgent !== "claude") {
            return;
          }
          throw new Error(`acp cron cli verify did not create job ${cronProbe.name}`);
        }
        await runOpenClawCliJson(
          ["cron", "rm", cronJobId, "--json", "--url", `ws://127.0.0.1:${port}`, "--token", token],
          process.env,
        );
        logLiveStep("bound session created cron via MCP and CLI verification passed");
      } finally {
        releasePinnedPluginChannelRegistry(channelRegistry);
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
        await server.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
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
    LIVE_TIMEOUT_MS + 360_000,
  );
});

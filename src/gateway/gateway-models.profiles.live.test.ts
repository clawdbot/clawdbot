import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";
import { describe, it } from "vitest";
import { resolveMoltbotAgentDir } from "../agents/agent-paths.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import {
  collectAnthropicApiKeys,
  isAnthropicBillingError,
  isAnthropicRateLimitError,
} from "../agents/live-auth-keys.js";
import { isModernModelRef } from "../agents/live-model-filter.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { ensureMoltbotModelsJson } from "../agents/models-config.js";
import { loadConfig } from "../config/config.js";
import type { MoltbotConfig, ModelProviderConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const GATEWAY_LIVE = isTruthyEnvValue(process.env.CLAWDBOT_LIVE_GATEWAY);
const ZAI_FALLBACK = isTruthyEnvValue(process.env.CLAWDBOT_LIVE_GATEWAY_ZAI_FALLBACK);
const PROVIDERS = parseFilter(process.env.CLAWDBOT_LIVE_GATEWAY_PROVIDERS);
const THINKING_LEVEL = "high";
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/i;
const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";

const describeLive = LIVE || GATEWAY_LIVE ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function logProgress(message: string): void {
  console.log(`[live] ${message}`);
}

function assertNoReasoningTags(params: {
  text: string;
  model: string;
  phase: string;
  label: string;
}): void {
  if (!params.text) return;
  if (THINKING_TAG_RE.test(params.text) || FINAL_TAG_RE.test(params.text)) {
    const snippet = params.text.length > 200 ? `${params.text.slice(0, 200)}…` : params.text;
    throw new Error(
      `[${params.label}] reasoning tag leak (${params.model} / ${params.phase}): ${snippet}`,
    );
  }
}

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

function isMeaningful(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "ok") return false;
  if (trimmed.length < 60) return false;
  const words = trimmed.split(/\s+/g).filter(Boolean);
  if (words.length < 12) return false;
  return true;
}

function isGoogleModelNotFoundText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/not found/i.test(trimmed)) return false;
  if (/models\/.+ is not found for api version/i.test(trimmed)) return true;
  if (/"status"\s*:\s*"NOT_FOUND"/.test(trimmed)) return true;
  if (/"code"\s*:\s*404/.test(trimmed)) return true;
  return false;
}

function isGoogleishProvider(provider: string): boolean {
  return provider === "google" || provider.startsWith("google-");
}

function isRefreshTokenReused(error: string): boolean {
  return /refresh_token_reused/i.test(error);
}

function isChatGPTUsageLimitErrorMessage(raw: string): boolean {
  const msg = raw.toLowerCase();
  return msg.includes("hit your chatgpt usage limit") && msg.includes("try again in");
}

function isInstructionsRequiredError(error: string): boolean {
  return /instructions are required/i.test(error);
}

function isOpenAIReasoningSequenceError(error: string): boolean {
  const msg = error.toLowerCase();
  return msg.includes("required following item") && msg.includes("reasoning");
}

function isToolNonceRefusal(error: string): boolean {
  const msg = error.toLowerCase();
  if (!msg.includes("nonce")) return false;
  return (
    msg.includes("token") ||
    msg.includes("secret") ||
    msg.includes("local file") ||
    msg.includes("disclose") ||
    msg.includes("can't help") ||
    msg.includes("can’t help") ||
    msg.includes("can't comply") ||
    msg.includes("can’t comply")
  );
}

function isMissingProfileError(error: string): boolean {
  return /no credentials found for profile/i.test(error);
}

function isEmptyStreamText(text: string): boolean {
  return text.includes("request ended without sending any chunks");
}

function buildAnthropicRefusalToken(): string {
  const suffix = randomUUID().replace(/-/g, "");
  return `${ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL}_${suffix}`;
}

async function runAnthropicRefusalProbe(params: {
  client: GatewayClient;
  sessionKey: string;
  modelKey: string;
  label: string;
  thinkingLevel: string;
}): Promise<void> {
  logProgress(`${params.label}: refusal-probe`);
  const magic = buildAnthropicRefusalToken();
  const runId = randomUUID();
  const probe = await params.client.request<AgentFinalPayload>(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${runId}-refusal`,
      message: `Reply with the single word ok. Test token: ${magic}`,
      thinking: params.thinkingLevel,
      deliver: false,
    },
    { expectFinal: true },
  );
  if (probe?.status !== "ok") {
    throw new Error(`refusal probe failed: status=${String(probe?.status)}`);
  }
  const probeText = extractPayloadText(probe?.result);
  assertNoReasoningTags({
    text: probeText,
    model: params.modelKey,
    phase: "refusal-probe",
    label: params.label,
  });
  if (!/\bok\b/i.test(probeText)) {
    throw new Error(`refusal probe missing ok: ${probeText}`);
  }

  const followupId = randomUUID();
  const followup = await params.client.request<AgentFinalPayload>(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${followupId}-refusal-followup`,
      message: "Now reply with exactly: still ok.",
      thinking: params.thinkingLevel,
      deliver: false,
    },
    { expectFinal: true },
  );
  if (followup?.status !== "ok") {
    throw new Error(`refusal followup failed: status=${String(followup?.status)}`);
  }
  const followupText = extractPayloadText(followup?.result);
  assertNoReasoningTags({
    text: followupText,
    model: params.modelKey,
    phase: "refusal-followup",
    label: params.label,
  });
  if (!/\bstill\b/i.test(followupText) || !/\bok\b/i.test(followupText)) {
    throw new Error(`refusal followup missing expected text: ${followupText}`);
  }
}

function randomImageProbeCode(len = 6): string {
  // Chosen to avoid common OCR confusions in our 5x7 bitmap font.
  // Notably: 0↔8, B↔8, 6↔9, 3↔B, D↔0.
  // Must stay within the glyph set in `src/gateway/live-image-probe.ts`.
  const alphabet = "24567ACEF";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let prev = Array.from({ length: bLen + 1 }, (_v, idx) => idx);
  let curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i += 1) {
    curr[0] = i;
    const aCh = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j += 1) {
      const cost = aCh === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // delete
        curr[j - 1] + 1, // insert
        prev[j - 1] + cost, // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[bLen] ?? Number.POSITIVE_INFINITY;
}
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreeGatewayPort(): Promise<number> {
  // Gateway uses derived ports (browser/canvas). Avoid flaky collisions by
  // ensuring the common derived offsets are free too.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreePort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (await Promise.all(candidates.map((candidate) => isPortFree(candidate)))).every(
      Boolean,
    );
    if (ok) return port;
  }
  throw new Error("failed to acquire a free gateway port block");
}

type AgentFinalPayload = {
  status?: unknown;
  result?: unknown;
};

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, client?: GatewayClient) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(client as GatewayClient);
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "vitest-live",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.TEST,
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(() => stop(new Error("gateway connect timeout")), 10_000);
    timer.unref();
    client.start();
  });
}

type GatewayModelSuiteParams = {
  label: string;
  cfg: MoltbotConfig;
  candidates: Array<Model<Api>>;
  extraToolProbes: boolean;
  extraImageProbes: boolean;
  thinkingLevel: string;
  providerOverrides?: Record<string, ModelProviderConfig>;
};

function buildLiveGatewayConfig(params: {
  cfg: MoltbotConfig;
  candidates: Array<Model<Api>>;
  providerOverrides?: Record<string, ModelProviderConfig>;
}): MoltbotConfig {
  const providerOverrides = params.providerOverrides ?? {};
  const lmstudioProvider = params.cfg.models?.providers?.lmstudio;
  const baseProviders = params.cfg.models?.providers ?? {};
  const nextProviders = {
    ...baseProviders,
    ...(lmstudioProvider
      ? {
          lmstudio: {
            ...lmstudioProvider,
            api: "openai-completions",
          },
        }
      : {}),
    ...providerOverrides,
  };
  const providers = Object.keys(nextProviders).length > 0 ? nextProviders : baseProviders;
  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      list: (params.cfg.agents?.list ?? []).map((entry) => ({
        ...entry,
        sandbox: { mode: "off" },
      })),
      defaults: {
        ...params.cfg.agents?.defaults,
        // Live tests should avoid Docker sandboxing so tool probes can
        // operate on the temporary probe files we create in the host workspace.
        sandbox: { mode: "off" },
        models: Object.fromEntries(params.candidates.map((m) => [`${m.provider}/${m.id}`, {}])),
      },
    },
    models:
      Object.keys(providers).length > 0 ? { ...params.cfg.models, providers } : params.cfg.models,
  };
}

function sanitizeAuthConfig(params: {
  cfg: MoltbotConfig;
  agentDir: string;
}): MoltbotConfig["auth"] | undefined {
  const auth = params.cfg.auth;
  if (!auth) return auth;
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });

  let profiles: NonNullable<MoltbotConfig["auth"]>["profiles"] | undefined;
  if (auth.profiles) {
    profiles = {};
    for (const [profileId, profile] of Object.entries(auth.profiles)) {
      if (!store.profiles[profileId]) continue;
      profiles[profileId] = profile;
    }
    if (Object.keys(profiles).length === 0) profiles = undefined;
  }

  let order: Record<string, string[]> | undefined;
  if (auth.order) {
    order = {};
    for (const [provider, ids] of Object.entries(auth.order)) {
      const filtered = ids.filter((id) => Boolean(store.profiles[id]));
      if (filtered.length === 0) continue;
      order[provider] = filtered;
    }
    if (Object.keys(order).length === 0) order = undefined;
  }

  if (!profiles && !order && !auth.cooldowns) return undefined;
  return {
    ...auth,
    profiles,
    order,
  };
}

function buildMinimaxProviderOverride(params: {
  cfg: MoltbotConfig;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
}): ModelProviderConfig | null {
  const existing = params.cfg.models?.providers?.minimax;
  if (!existing || !Array.isArray(existing.models) || existing.models.length === 0) return null;
  return {
    ...existing,
    api: params.api,
    baseUrl: params.baseUrl,
  };
}

async function runGatewayModelSuite(params: GatewayModelSuiteParams) {
  const previous = {
    configPath: process.env.CLAWDBOT_CONFIG_PATH,
    token: process.env.CLAWDBOT_GATEWAY_TOKEN,
    skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
    skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
    skipCron: process.env.CLAWDBOT_SKIP_CRON,
    skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    agentDir: process.env.CLAWDBOT_AGENT_DIR,
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    stateDir: process.env.CLAWDBOT_STATE_DIR,
  };
  let tempAgentDir: string | undefined;
  let tempStateDir: string | undefined;

  process.env.CLAWDBOT_SKIP_CHANNELS = "1";
  process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
  process.env.CLAWDBOT_SKIP_CRON = "1";
  process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

  const token = `test-${randomUUID()}`;
  process.env.CLAWDBOT_GATEWAY_TOKEN = token;
  const agentId = "dev";

  const hostAgentDir = resolveMoltbotAgentDir();
  const hostStore = ensureAuthProfileStore(hostAgentDir, {
    allowKeychainPrompt: false,
  });
  const sanitizedStore: AuthProfileStore = {
    version: hostStore.version,
    profiles: { ...hostStore.profiles },
    // Keep selection state so the gateway picks the same known-good profiles
    // as the host (important when some profiles are rate-limited/disabled).
    order: hostStore.order ? { ...hostStore.order } : undefined,
    lastGood: hostStore.lastGood ? { ...hostStore.lastGood } : undefined,
    usageStats: hostStore.usageStats ? { ...hostStore.usageStats } : undefined,
  };
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-live-state-"));
  process.env.CLAWDBOT_STATE_DIR = tempStateDir;
  tempAgentDir = path.join(tempStateDir, "agents", DEFAULT_AGENT_ID, "agent");
  saveAuthProfileStore(sanitizedStore, tempAgentDir);
  const tempSessionAgentDir = path.join(tempStateDir, "agents", agentId, "agent");
  if (tempSessionAgentDir !== tempAgentDir) {
    saveAuthProfileStore(sanitizedStore, tempSessionAgentDir);
  }
  process.env.CLAWDBOT_AGENT_DIR = tempAgentDir;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  await fs.mkdir(workspaceDir, { recursive: true });
  const nonceA = randomUUID();
  const nonceB = randomUUID();
  const toolProbePath = path.join(workspaceDir, `.clawdbot-live-tool-probe.${nonceA}.txt`);
  await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

  const agentDir = resolveMoltbotAgentDir();
  const sanitizedCfg: MoltbotConfig = {
    ...params.cfg,
    auth: sanitizeAuthConfig({ cfg: params.cfg, agentDir }),
  };
  const nextCfg = buildLiveGatewayConfig({
    cfg: sanitizedCfg,
    candidates: params.candidates,
    providerOverrides: params.providerOverrides,
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-live-"));
  const tempConfigPath = path.join(tempDir, "moltbot.json");
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
  process.env.CLAWDBOT_CONFIG_PATH = tempConfigPath;

  await ensureMoltbotModelsJson(nextCfg);

  const port = await getFreeGatewayPort();
  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
  });

  const client = await connectClient({
    url: `ws://127.0.0.1:${port}`,
    token,
  });

  try {
    logProgress(
      `[${params.label}] running ${params.candidates.length} models (thinking=${params.thinkingLevel})`,
    );
    const anthropicKeys = collectAnthropicApiKeys();
    if (anthropicKeys.length > 0) {
      process.env.ANTHROPIC_API_KEY = anthropicKeys[0];
      logProgress(`[${params.label}] anthropic keys loaded: ${anthropicKeys.length}`);
    }
    const sessionKey = `agent:${agentId}:${params.label}`;
    const failures: Array<{ model: string; error: string }> = [];
    let skippedCount = 0;
    const total = params.candidates.length;

    for (const [index, model] of params.candidates.entries()) {
      const modelKey = `${model.provider}/${model.id}`;
      const progressLabel = `[${params.label}] ${index + 1}/${total} ${modelKey}`;

      const attemptMax =
        model.provider === "anthropic" && anthropicKeys.length > 0 ? anthropicKeys.length : 1;

      for (let attempt = 0; attempt < attemptMax; attempt += 1) {
        if (model.provider === "anthropic" && anthropicKeys.length > 0) {
          process.env.ANTHROPIC_API_KEY = anthropicKeys[attempt];
        }
        try {
          // Ensure session exists + override model for this run.
          // Reset between models: avoids cross-provider transcript incompatibilities
          // (notably OpenAI Responses requiring reasoning replay for function_call items).
          await client.request<Record<string, unknown>>("sessions.reset", {
            key: sessionKey,
          });
          await client.request<Record<string, unknown>>("sessions.patch", {
            key: sessionKey,
            model: modelKey,
          });

          logProgress(`${progressLabel}: prompt`);
          const runId = randomUUID();
          const payload = await client.request<AgentFinalPayload>(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${runId}`,
              message:
                "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
              thinking: params.thinkingLevel,
              deliver: false,
            },
            { expectFinal: true },
          );

          if (payload?.status !== "ok") {
            throw new Error(`agent status=${String(payload?.status)}`);
          }
          let text = extractPayloadText(payload?.result);
          if (!text) {
            logProgress(`${progressLabel}: empty response, retrying`);
            const retry = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${randomUUID()}-retry`,
                message:
                  "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                thinking: params.thinkingLevel,
                deliver: false,
              },
              { expectFinal: true },
            );
            if (retry?.status !== "ok") {
              throw new Error(`agent status=${String(retry?.status)}`);
            }
            text = extractPayloadText(retry?.result);
          }
          if (!text && isGoogleishProvider(model.provider)) {
            logProgress(`${progressLabel}: skip (google empty response)`);
            break;
          }
          if (
            isEmptyStreamText(text) &&
            (model.provider === "minimax" || model.provider === "openai-codex")
          ) {
            logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
            break;
          }
          if (isGoogleishProvider(model.provider) && isGoogleModelNotFoundText(text)) {
            // Catalog drift: model IDs can disappear or become unavailable on the API.
            // Treat as skip when scanning "all models" for Google.
            logProgress(`${progressLabel}: skip (google model not found)`);
            break;
          }
          assertNoReasoningTags({
            text,
            model: modelKey,
            phase: "prompt",
            label: params.label,
          });
          if (!isMeaningful(text)) {
            if (isGoogleishProvider(model.provider) && /gemini/i.test(model.id)) {
              logProgress(`${progressLabel}: skip (google not meaningful)`);
              break;
            }
            throw new Error(`not meaningful: ${text}`);
          }
          if (!/\bmicro\s*-?\s*tasks?\b/i.test(text) || !/\bmacro\s*-?\s*tasks?\b/i.test(text)) {
            throw new Error(`missing required keywords: ${text}`);
          }

          // Real tool invocation: force the agent to Read a local file and echo a nonce.
          logProgress(`${progressLabel}: tool-read`);
          const runIdTool = randomUUID();
          const toolProbe = await client.request<AgentFinalPayload>(
            "agent",
            {
              sessionKey,
              idempotencyKey: `idem-${runIdTool}-tool`,
              message:
                "Moltbot live tool probe (local, safe): " +
                `use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolProbePath}"}. ` +
                "Then reply with the two nonce values you read (include both).",
              thinking: params.thinkingLevel,
              deliver: false,
            },
            { expectFinal: true },
          );
          if (toolProbe?.status !== "ok") {
            throw new Error(`tool probe failed: status=${String(toolProbe?.status)}`);
          }
          const toolText = extractPayloadText(toolProbe?.result);
          if (
            isEmptyStreamText(toolText) &&
            (model.provider === "minimax" || model.provider === "openai-codex")
          ) {
            logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
            break;
          }
          assertNoReasoningTags({
            text: toolText,
            model: modelKey,
            phase: "tool-read",
            label: params.label,
          });
          if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
            throw new Error(`tool probe missing nonce: ${toolText}`);
          }

          if (params.extraToolProbes) {
            logProgress(`${progressLabel}: tool-exec`);
            const nonceC = randomUUID();
            const toolWritePath = path.join(tempDir, `write-${runIdTool}.txt`);

            const execReadProbe = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runIdTool}-exec-read`,
                message:
                  "Moltbot live tool probe (local, safe): " +
                  "use the tool named `exec` (or `Exec`) to run this command: " +
                  `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}". ` +
                  `Then use the tool named \`read\` (or \`Read\`) with JSON arguments {"path":"${toolWritePath}"}. ` +
                  "Finally reply including the nonce text you read back.",
                thinking: params.thinkingLevel,
                deliver: false,
              },
              { expectFinal: true },
            );
            if (execReadProbe?.status !== "ok") {
              throw new Error(`exec+read probe failed: status=${String(execReadProbe?.status)}`);
            }
            const execReadText = extractPayloadText(execReadProbe?.result);
            if (
              isEmptyStreamText(execReadText) &&
              (model.provider === "minimax" || model.provider === "openai-codex")
            ) {
              logProgress(`${progressLabel}: skip (${model.provider} empty response)`);
              break;
            }
            assertNoReasoningTags({
              text: execReadText,
              model: modelKey,
              phase: "tool-exec",
              label: params.label,
            });
            if (!execReadText.includes(nonceC)) {
              throw new Error(`exec+read probe missing nonce: ${execReadText}`);
            }

            await fs.rm(toolWritePath, { force: true });
          }

          if (params.extraImageProbes && model.input?.includes("image")) {
            logProgress(`${progressLabel}: image`);
            // Shorter code => less OCR flake across providers, still tests image attachments end-to-end.
            const imageCode = randomImageProbeCode();
            const imageBase64 = renderCatNoncePngBase64(imageCode);
            const runIdImage = randomUUID();

            const imageProbe = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runIdImage}-image`,
                message:
                  "Look at the attached image. Reply with exactly two tokens separated by a single space: " +
                  "(1) the animal shown or written in the image, lowercase; " +
                  "(2) the code printed in the image, uppercase. No extra text.",
                attachments: [
                  {
                    mimeType: "image/png",
                    fileName: `probe-${runIdImage}.png`,
                    content: imageBase64,
                  },
                ],
                thinking: params.thinkingLevel,
                deliver: false,
              },
              { expectFinal: true },
            );
            // Best-effort: do not fail the whole live suite on flaky image handling.
            // (We still keep prompt + tool probes as hard checks.)
            if (imageProbe?.status !== "ok") {
              logProgress(`${progressLabel}: image skip (status=${String(imageProbe?.status)})`);
            } else {
              const imageText = extractPayloadText(imageProbe?.result);
              if (
                isEmptyStreamText(imageText) &&
                (model.provider === "minimax" || model.provider === "openai-codex")
              ) {
                logProgress(`${progressLabel}: image skip (${model.provider} empty response)`);
              } else {
                assertNoReasoningTags({
                  text: imageText,
                  model: modelKey,
                  phase: "image",
                  label: params.label,
                });
                if (!/\bcat\b/i.test(imageText)) {
                  logProgress(`${progressLabel}: image skip (missing 'cat')`);
                } else {
                  const candidates = imageText.toUpperCase().match(/[A-Z0-9]{6,20}/g) ?? [];
                  const bestDistance = candidates.reduce((best, cand) => {
                    if (Math.abs(cand.length - imageCode.length) > 2) return best;
                    return Math.min(best, editDistance(cand, imageCode));
                  }, Number.POSITIVE_INFINITY);
                  // OCR / image-read flake: allow a small edit distance, but still require the "cat" token above.
                  if (!(bestDistance <= 3)) {
                    logProgress(`${progressLabel}: image skip (code mismatch)`);
                  }
                }
              }
            }
          }

          // Regression: tool-call-only turn followed by a user message (OpenAI responses bug class).
          if (
            (model.provider === "openai" && model.api === "openai-responses") ||
            (model.provider === "openai-codex" && model.api === "openai-codex-responses")
          ) {
            logProgress(`${progressLabel}: tool-only regression`);
            const runId2 = randomUUID();
            const first = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runId2}-1`,
                message: `Call the tool named \`read\` (or \`Read\`) on "${toolProbePath}". Do not write any other text.`,
                thinking: params.thinkingLevel,
                deliver: false,
              },
              { expectFinal: true },
            );
            if (first?.status !== "ok") {
              throw new Error(`tool-only turn failed: status=${String(first?.status)}`);
            }
            const firstText = extractPayloadText(first?.result);
            assertNoReasoningTags({
              text: firstText,
              model: modelKey,
              phase: "tool-only",
              label: params.label,
            });

            const second = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runId2}-2`,
                message: `Now answer: what are the values of nonceA and nonceB in "${toolProbePath}"? Reply with exactly: ${nonceA} ${nonceB}.`,
                thinking: params.thinkingLevel,
                deliver: false,
              },
              { expectFinal: true },
            );
            if (second?.status !== "ok") {
              throw new Error(`post-tool message failed: status=${String(second?.status)}`);
            }
            const reply = extractPayloadText(second?.result);
            assertNoReasoningTags({
              text: reply,
              model: modelKey,
              phase: "tool-only-followup",
              label: params.label,
            });
            if (!reply.includes(nonceA) || !reply.includes(nonceB)) {
              throw new Error(`unexpected reply: ${reply}`);
            }
          }

          if (model.provider === "anthropic") {
            await runAnthropicRefusalProbe({
              client,
              sessionKey,
              modelKey,
              label: progressLabel,
              thinkingLevel: params.thinkingLevel,
            });
          }

          logProgress(`${progressLabel}: done`);
          break;
        } catch (err) {
          const message = String(err);
          if (
            model.provider === "anthropic" &&
            isAnthropicRateLimitError(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: rate limit, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isAnthropicBillingError(message)) {
            if (attempt + 1 < attemptMax) {
              logProgress(`${progressLabel}: billing issue, retrying with next key`);
              continue;
            }
            logProgress(`${progressLabel}: skip (anthropic billing)`);
            break;
          }
          if (
            model.provider === "anthropic" &&
            isEmptyStreamText(message) &&
            attempt + 1 < attemptMax
          ) {
            logProgress(`${progressLabel}: empty response, retrying with next key`);
            continue;
          }
          if (model.provider === "anthropic" && isEmptyStreamText(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (anthropic empty response)`);
            break;
          }
          // OpenAI Codex refresh tokens can become single-use; skip instead of failing all live tests.
          if (model.provider === "openai-codex" && isRefreshTokenReused(message)) {
            logProgress(`${progressLabel}: skip (codex refresh token reused)`);
            break;
          }
          if (model.provider === "openai-codex" && isChatGPTUsageLimitErrorMessage(message)) {
            logProgress(`${progressLabel}: skip (chatgpt usage limit)`);
            break;
          }
          if (model.provider === "openai-codex" && isInstructionsRequiredError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (instructions required)`);
            break;
          }
          if (
            (model.provider === "openai" || model.provider === "openai-codex") &&
            isOpenAIReasoningSequenceError(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (openai reasoning sequence error)`);
            break;
          }
          if (
            (model.provider === "openai" || model.provider === "openai-codex") &&
            isToolNonceRefusal(message)
          ) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (tool probe refusal)`);
            break;
          }
          if (isMissingProfileError(message)) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (missing auth profile)`);
            break;
          }
          if (params.label.startsWith("minimax-")) {
            skippedCount += 1;
            logProgress(`${progressLabel}: skip (minimax endpoint error)`);
            break;
          }
          logProgress(`${progressLabel}: failed`);
          failures.push({ model: modelKey, error: message });
          break;
        }
      }
    }

    if (failures.length > 0) {
      const preview = failures
        .slice(0, 20)
        .map((f) => `- ${f.model}: ${f.error}`)
        .join("\n");
      throw new Error(`gateway live model failures (${failures.length}):\n${preview}`);
    }
    if (skippedCount === total) {
      logProgress(`[${params.label}] skipped all models (missing profiles)`);
    }
  } finally {
    client.stop();
    await server.close({ reason: "live test complete" });
    await fs.rm(toolProbePath, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    if (tempAgentDir) {
      await fs.rm(tempAgentDir, { recursive: true, force: true });
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
    }

    process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
    process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
    process.env.CLAWDBOT_SKIP_CHANNELS = previous.skipChannels;
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
    process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
    process.env.CLAWDBOT_AGENT_DIR = previous.agentDir;
    process.env.PI_CODING_AGENT_DIR = previous.piAgentDir;
    process.env.CLAWDBOT_STATE_DIR = previous.stateDir;
  }
}

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () => {
      const cfg = loadConfig();
      await ensureMoltbotModelsJson(cfg);

      const agentDir = resolveMoltbotAgentDir();
      const authStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const all = modelRegistry.getAll() as Array<Model<Api>>;

      const rawModels = process.env.CLAWDBOT_LIVE_GATEWAY_MODELS?.trim();
      const useModern = !rawModels || rawModels === "modern" || rawModels === "all";
      const useExplicit = Boolean(rawModels) && !useModern;
      const filter = useExplicit ? parseFilter(rawModels) : null;
      const wanted = filter
        ? all.filter((m) => filter.has(`${m.provider}/${m.id}`))
        : all.filter((m) => isModernModelRef({ provider: m.provider, id: m.id }));

      const candidates: Array<Model<Api>> = [];
      for (const model of wanted) {
        if (PROVIDERS && !PROVIDERS.has(model.provider)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const apiKeyInfo = await getApiKeyForModel({
            model,
            cfg,
            store: authStore,
            agentDir,
          });
          if (!apiKeyInfo.source.startsWith("profile:")) {
            continue;
          }
          candidates.push(model);
        } catch {
          // no creds; skip
        }
      }

      if (candidates.length === 0) {
        logProgress("[all-models] no API keys found; skipping");
        return;
      }
      logProgress(`[all-models] selection=${useExplicit ? "explicit" : "modern"}`);
      const imageCandidates = candidates.filter((m) => m.input?.includes("image"));
      if (imageCandidates.length === 0) {
        logProgress("[all-models] no image-capable models selected; image probe will be skipped");
      }
      await runGatewayModelSuite({
        label: "all-models",
        cfg,
        candidates,
        extraToolProbes: true,
        extraImageProbes: true,
        thinkingLevel: THINKING_LEVEL,
      });

      const minimaxCandidates = candidates.filter((model) => model.provider === "minimax");
      if (minimaxCandidates.length === 0) {
        logProgress("[minimax] no candidates with keys; skipping dual endpoint probes");
        return;
      }

      const minimaxAnthropic = buildMinimaxProviderOverride({
        cfg,
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
      });
      if (minimaxAnthropic) {
        await runGatewayModelSuite({
          label: "minimax-anthropic",
          cfg,
          candidates: minimaxCandidates,
          extraToolProbes: true,
          extraImageProbes: true,
          thinkingLevel: THINKING_LEVEL,
          providerOverrides: { minimax: minimaxAnthropic },
        });
      } else {
        logProgress("[minimax-anthropic] missing minimax provider config; skipping");
      }
    },
    20 * 60 * 1000,
  );

  it("z.ai fallback handles anthropic tool history", async () => {
    if (!ZAI_FALLBACK) return;
    const previous = {
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
    };

    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

    const token = `test-${randomUUID()}`;
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;

    const cfg = loadConfig();
    await ensureMoltbotModelsJson(cfg);

    const agentDir = resolveMoltbotAgentDir();
    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);
    const anthropic = modelRegistry.find("anthropic", "claude-opus-4-5") as Model<Api> | null;
    const zai = modelRegistry.find("zai", "glm-4.7") as Model<Api> | null;

    if (!anthropic || !zai) return;
    try {
      await getApiKeyForModel({ model: anthropic, cfg });
      await getApiKeyForModel({ model: zai, cfg });
    } catch {
      return;
    }

    const agentId = "dev";
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    await fs.mkdir(workspaceDir, { recursive: true });
    const nonceA = randomUUID();
    const nonceB = randomUUID();
    const toolProbePath = path.join(workspaceDir, `.clawdbot-live-zai-fallback.${nonceA}.txt`);
    await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

    const port = await getFreeGatewayPort();
    const server = await startGatewayServer({
      configPath: cfg.__meta?.path,
      port,
      token,
    });

    const client = await connectClient({
      url: `ws://127.0.0.1:${port}`,
      token,
    });

    try {
      const sessionKey = `agent:${agentId}:live-zai-fallback`;

      await client.request<Record<string, unknown>>("sessions.patch", {
        key: sessionKey,
        model: "anthropic/claude-opus-4-5",
      });
      await client.request<Record<string, unknown>>("sessions.reset", {
        key: sessionKey,
      });

      const runId = randomUUID();
      const toolProbe = await client.request<AgentFinalPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${runId}-tool`,
          message:
            `Call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) with JSON arguments {"path":"${toolProbePath}"}. ` +
            `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
          thinking: THINKING_LEVEL,
          deliver: false,
        },
        { expectFinal: true },
      );
      if (toolProbe?.status !== "ok") {
        throw new Error(`anthropic tool probe failed: status=${String(toolProbe?.status)}`);
      }
      const toolText = extractPayloadText(toolProbe?.result);
      assertNoReasoningTags({
        text: toolText,
        model: "anthropic/claude-opus-4-5",
        phase: "zai-fallback-tool",
        label: "zai-fallback",
      });
      if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
        throw new Error(`anthropic tool probe missing nonce: ${toolText}`);
      }

      await client.request<Record<string, unknown>>("sessions.patch", {
        key: sessionKey,
        model: "zai/glm-4.7",
      });

      const followupId = randomUUID();
      const followup = await client.request<AgentFinalPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${followupId}-followup`,
          message:
            `What are the values of nonceA and nonceB in "${toolProbePath}"? ` +
            `Reply with exactly: ${nonceA} ${nonceB}.`,
          thinking: THINKING_LEVEL,
          deliver: false,
        },
        { expectFinal: true },
      );
      if (followup?.status !== "ok") {
        throw new Error(`zai followup failed: status=${String(followup?.status)}`);
      }
      const followupText = extractPayloadText(followup?.result);
      assertNoReasoningTags({
        text: followupText,
        model: "zai/glm-4.7",
        phase: "zai-fallback-followup",
        label: "zai-fallback",
      });
      if (!followupText.includes(nonceA) || !followupText.includes(nonceB)) {
        throw new Error(`zai followup missing nonce: ${followupText}`);
      }
    } finally {
      client.stop();
      await server.close({ reason: "live test complete" });
      await fs.rm(toolProbePath, { force: true });

      process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
      process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
      process.env.CLAWDBOT_SKIP_CHANNELS = previous.skipChannels;
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
      process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
    }
  }, 180_000);
});

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveClawdbotAgentDir } from "../agents/agent-paths.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { ensureClawdbotModelsJson } from "../agents/models-config.js";
import { loadConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";
const GATEWAY_LIVE = process.env.CLAWDBOT_LIVE_GATEWAY === "1";
const ALL_MODELS =
  process.env.CLAWDBOT_LIVE_GATEWAY_ALL_MODELS === "1" ||
  process.env.CLAWDBOT_LIVE_GATEWAY_MODELS === "all";
const EXTRA_TOOL_PROBES = process.env.CLAWDBOT_LIVE_GATEWAY_TOOL_PROBE === "1";
const EXTRA_IMAGE_PROBES =
  process.env.CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE === "1";
const PROVIDERS = parseFilter(process.env.CLAWDBOT_LIVE_GATEWAY_PROVIDERS);

const describeLive = LIVE && GATEWAY_LIVE ? describe : describe.skip;

function parseFilter(raw?: string): Set<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "all") return null;
  const ids = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) =>
      p && typeof p === "object"
        ? (p as Record<string, unknown>).text
        : undefined,
    )
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

function randomImageProbeCode(len = 10): string {
  const alphabet = "2345689ABCEF";
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
  // Gateway uses derived ports (bridge/browser/canvas). Avoid flaky collisions by
  // ensuring the common derived offsets are free too.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getFreePort();
    const candidates = [port, port + 1, port + 2, port + 4];
    const ok = (
      await Promise.all(candidates.map((candidate) => isPortFree(candidate)))
    ).every(Boolean);
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
      clientName: "vitest-live",
      clientVersion: "dev",
      mode: "test",
      onHelloOk: () => stop(undefined, client),
      onConnectError: (err) => stop(err),
      onClose: (code, reason) =>
        stop(new Error(`gateway closed during connect (${code}): ${reason}`)),
    });
    const timer = setTimeout(
      () => stop(new Error("gateway connect timeout")),
      10_000,
    );
    timer.unref();
    client.start();
  });
}

describeLive("gateway live (dev agent, profile keys)", () => {
  it(
    "runs meaningful prompts across models with available keys",
    async () => {
      const previous = {
        configPath: process.env.CLAWDBOT_CONFIG_PATH,
        token: process.env.CLAWDBOT_GATEWAY_TOKEN,
        skipProviders: process.env.CLAWDBOT_SKIP_PROVIDERS,
        skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
        skipCron: process.env.CLAWDBOT_SKIP_CRON,
        skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
      };

      process.env.CLAWDBOT_SKIP_PROVIDERS = "1";
      process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
      process.env.CLAWDBOT_SKIP_CRON = "1";
      process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";

      const token = `test-${randomUUID()}`;
      process.env.CLAWDBOT_GATEWAY_TOKEN = token;

      const cfg = loadConfig();
      await ensureClawdbotModelsJson(cfg);

      const workspaceDir = resolveUserPath(
        cfg.agents?.defaults?.workspace ?? path.join(os.homedir(), "clawd"),
      );
      await fs.mkdir(workspaceDir, { recursive: true });
      const nonceA = randomUUID();
      const nonceB = randomUUID();
      const toolProbePath = path.join(
        workspaceDir,
        `.clawdbot-live-tool-probe.${nonceA}.txt`,
      );
      await fs.writeFile(toolProbePath, `nonceA=${nonceA}\nnonceB=${nonceB}\n`);

      const agentDir = resolveClawdbotAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const all = modelRegistry.getAll() as Array<Model<Api>>;

      const filter = parseFilter(process.env.CLAWDBOT_LIVE_GATEWAY_MODELS);

      // Default: honor user allowlist. Opt-in: scan all models with keys.
      const allowlistKeys = Object.keys(cfg.agents?.defaults?.models ?? {});
      const wanted =
        ALL_MODELS || allowlistKeys.length === 0
          ? all
          : all.filter((m) => allowlistKeys.includes(`${m.provider}/${m.id}`));

      const candidates: Array<Model<Api>> = [];
      for (const model of wanted) {
        const id = `${model.provider}/${model.id}`;
        if (PROVIDERS && !PROVIDERS.has(model.provider)) continue;
        if (filter && !filter.has(id)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await getApiKeyForModel({ model, cfg });
          candidates.push(model);
        } catch {
          // no creds; skip
        }
      }

      expect(candidates.length).toBeGreaterThan(0);
      const imageCandidates = EXTRA_IMAGE_PROBES
        ? candidates.filter((m) => m.input?.includes("image"))
        : [];
      if (EXTRA_IMAGE_PROBES && imageCandidates.length === 0) {
        throw new Error(
          "image probe enabled but no selected models advertise image support; set CLAWDBOT_LIVE_GATEWAY_MODELS to include an image-capable model",
        );
      }

      // Build a temp config that allows all selected models, so session overrides stick.
      const lmstudioProvider = cfg.models?.providers?.lmstudio;
      const nextCfg = {
        ...cfg,
        agents: {
          ...cfg.agents,
          list: (cfg.agents?.list ?? []).map((entry) => ({
            ...entry,
            sandbox: { mode: "off" },
          })),
          defaults: {
            ...cfg.agents?.defaults,
            // Live tests should avoid Docker sandboxing so tool probes can
            // operate on the temporary probe files we create in the host workspace.
            sandbox: { mode: "off" },
            models: Object.fromEntries(
              candidates.map((m) => [`${m.provider}/${m.id}`, {}]),
            ),
          },
        },
        models: {
          ...cfg.models,
          providers: {
            ...cfg.models?.providers,
            // LM Studio is most reliable via Chat Completions; its Responses API
            // tool-calling behavior is inconsistent across releases.
            ...(lmstudioProvider
              ? {
                  lmstudio: {
                    ...lmstudioProvider,
                    api: "openai-completions",
                  },
                }
              : {}),
          },
        },
      };
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "clawdbot-live-"),
      );
      const tempConfigPath = path.join(tempDir, "clawdbot.json");
      await fs.writeFile(
        tempConfigPath,
        `${JSON.stringify(nextCfg, null, 2)}\n`,
      );
      process.env.CLAWDBOT_CONFIG_PATH = tempConfigPath;

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
        const sessionKey = "agent:dev:live-gateway";

        const failures: Array<{ model: string; error: string }> = [];

        for (const model of candidates) {
          const modelKey = `${model.provider}/${model.id}`;

          try {
            // Ensure session exists + override model for this run.
            await client.request<Record<string, unknown>>("sessions.patch", {
              key: sessionKey,
              model: modelKey,
            });
            // Reset between models: avoids cross-provider transcript incompatibilities
            // (notably OpenAI Responses requiring reasoning replay for function_call items).
            await client.request<Record<string, unknown>>("sessions.reset", {
              key: sessionKey,
            });

            // “Meaningful” direct prompt (no tools).
            const runId = randomUUID();
            const payload = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runId}`,
                message:
                  "Explain in 2-3 sentences how the JavaScript event loop handles microtasks vs macrotasks. Must mention both words: microtask and macrotask.",
                deliver: false,
              },
              { expectFinal: true },
            );

            if (payload?.status !== "ok") {
              throw new Error(`agent status=${String(payload?.status)}`);
            }
            const text = extractPayloadText(payload?.result);
            if (
              model.provider === "google" &&
              isGoogleModelNotFoundText(text)
            ) {
              // Catalog drift: model IDs can disappear or become unavailable on the API.
              // Treat as skip when scanning "all models" for Google.
              continue;
            }
            if (!isMeaningful(text)) throw new Error(`not meaningful: ${text}`);
            if (
              !/\bmicro\s*-?\s*tasks?\b/i.test(text) ||
              !/\bmacro\s*-?\s*tasks?\b/i.test(text)
            ) {
              throw new Error(`missing required keywords: ${text}`);
            }

            // Real tool invocation: force the agent to Read a local file and echo a nonce.
            const runIdTool = randomUUID();
            const toolProbe = await client.request<AgentFinalPayload>(
              "agent",
              {
                sessionKey,
                idempotencyKey: `idem-${runIdTool}-tool`,
                message:
                  `Call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) with JSON arguments {"path":"${toolProbePath}"}. ` +
                  `Then reply with exactly: ${nonceA} ${nonceB}. No extra text.`,
                deliver: false,
              },
              { expectFinal: true },
            );
            if (toolProbe?.status !== "ok") {
              throw new Error(
                `tool probe failed: status=${String(toolProbe?.status)}`,
              );
            }
            const toolText = extractPayloadText(toolProbe?.result);
            if (!toolText.includes(nonceA) || !toolText.includes(nonceB)) {
              throw new Error(`tool probe missing nonce: ${toolText}`);
            }

            if (EXTRA_TOOL_PROBES) {
              const nonceC = `nonceC=${randomUUID()}`;
              const toolWritePath = path.join(
                tempDir,
                `write-${runIdTool}.txt`,
              );

              const bashReadProbe = await client.request<AgentFinalPayload>(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${runIdTool}-bash-read`,
                  message:
                    `Call the tool named \`bash\` (or \`Bash\` if \`bash\` is unavailable) and run: ` +
                    `mkdir -p "${tempDir}" && printf '%s' '${nonceC}' > "${toolWritePath}" ` +
                    `Then call the tool named \`read\` (or \`Read\` if \`read\` is unavailable) with JSON arguments: {"path":"${toolWritePath}"} ` +
                    `Finally reply with exactly: ${nonceC}.`,
                  deliver: false,
                },
                { expectFinal: true },
              );
              if (bashReadProbe?.status !== "ok") {
                throw new Error(
                  `bash+read probe failed: status=${String(bashReadProbe?.status)}`,
                );
              }
              const bashReadText = extractPayloadText(bashReadProbe?.result);
              if (!bashReadText.includes(nonceC)) {
                throw new Error(
                  `bash+read probe missing nonce: ${bashReadText}`,
                );
              }

              await fs.rm(toolWritePath, { force: true });
            }

            if (EXTRA_IMAGE_PROBES && model.input?.includes("image")) {
              const imageCode = randomImageProbeCode(10);
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
                  deliver: false,
                },
                { expectFinal: true },
              );
              if (imageProbe?.status !== "ok") {
                throw new Error(
                  `image probe failed: status=${String(imageProbe?.status)}`,
                );
              }
              const imageText = extractPayloadText(imageProbe?.result);
              if (!/\bcat\b/i.test(imageText)) {
                throw new Error(`image probe missing 'cat': ${imageText}`);
              }
              const candidates =
                imageText.toUpperCase().match(/[A-Z0-9]{6,20}/g) ?? [];
              const bestDistance = candidates.reduce((best, cand) => {
                if (Math.abs(cand.length - imageCode.length) > 2) return best;
                return Math.min(best, editDistance(cand, imageCode));
              }, Number.POSITIVE_INFINITY);
              if (!(bestDistance <= 2)) {
                throw new Error(
                  `image probe missing code (${imageCode}): ${imageText}`,
                );
              }
            }

            // Regression: tool-call-only turn followed by a user message (OpenAI responses bug class).
            if (
              (model.provider === "openai" &&
                model.api === "openai-responses") ||
              (model.provider === "openai-codex" &&
                model.api === "openai-codex-responses")
            ) {
              const runId2 = randomUUID();
              const first = await client.request<AgentFinalPayload>(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-1`,
                  message: `Call the tool named \`read\` (or \`Read\`) on "${toolProbePath}". Do not write any other text.`,
                  deliver: false,
                },
                { expectFinal: true },
              );
              if (first?.status !== "ok") {
                throw new Error(
                  `tool-only turn failed: status=${String(first?.status)}`,
                );
              }

              const second = await client.request<AgentFinalPayload>(
                "agent",
                {
                  sessionKey,
                  idempotencyKey: `idem-${runId2}-2`,
                  message: `Now answer: what are the values of nonceA and nonceB in "${toolProbePath}"? Reply with exactly: ${nonceA} ${nonceB}.`,
                  deliver: false,
                },
                { expectFinal: true },
              );
              if (second?.status !== "ok") {
                throw new Error(
                  `post-tool message failed: status=${String(second?.status)}`,
                );
              }
              const reply = extractPayloadText(second?.result);
              if (!reply.includes(nonceA) || !reply.includes(nonceB)) {
                throw new Error(`unexpected reply: ${reply}`);
              }
            }
          } catch (err) {
            failures.push({ model: modelKey, error: String(err) });
          }
        }

        if (failures.length > 0) {
          const preview = failures
            .slice(0, 20)
            .map((f) => `- ${f.model}: ${f.error}`)
            .join("\n");
          throw new Error(
            `gateway live model failures (${failures.length}):\n${preview}`,
          );
        }
      } finally {
        client.stop();
        await server.close({ reason: "live test complete" });
        await fs.rm(toolProbePath, { force: true });
        await fs.rm(tempDir, { recursive: true, force: true });

        process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
        process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
        process.env.CLAWDBOT_SKIP_PROVIDERS = previous.skipProviders;
        process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
        process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
        process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
      }
    },
    20 * 60 * 1000,
  );
});

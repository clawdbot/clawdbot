import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { GatewayClient } from "./client.js";
import { renderCatNoncePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const CLI_LIVE = isTruthyEnvValue(process.env.CLAWDBOT_LIVE_CLI_BACKEND);
const CLI_IMAGE = isTruthyEnvValue(process.env.CLAWDBOT_LIVE_CLI_BACKEND_IMAGE_PROBE);
const CLI_RESUME = isTruthyEnvValue(process.env.CLAWDBOT_LIVE_CLI_BACKEND_RESUME_PROBE);
const describeLive = LIVE && CLI_LIVE ? describe : describe.skip;

const DEFAULT_MODEL = "claude-cli/claude-sonnet-4-5";
const DEFAULT_CLAUDE_ARGS = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
const DEFAULT_CODEX_ARGS = [
  "exec",
  "--json",
  "--color",
  "never",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
];
const DEFAULT_CLEAR_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"];

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

function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return texts.join("\n").trim();
}

function parseJsonStringArray(name: string, raw?: string): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

function parseImageMode(raw?: string): "list" | "repeat" | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "list" || trimmed === "repeat") return trimmed;
  throw new Error("CLAWDBOT_LIVE_CLI_BACKEND_IMAGE_MODE must be 'list' or 'repeat'.");
}

function withMcpConfigOverrides(args: string[], mcpConfigPath: string): string[] {
  const next = [...args];
  if (!next.includes("--strict-mcp-config")) {
    next.push("--strict-mcp-config");
  }
  if (!next.includes("--mcp-config")) {
    next.push("--mcp-config", mcpConfigPath);
  }
  return next;
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
      clientName: "vitest-live-cli-backend",
      clientVersion: "dev",
      mode: "test",
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

describeLive("gateway live (cli backend)", () => {
  it("runs the agent pipeline against the local CLI backend", async () => {
    const previous = {
      configPath: process.env.CLAWDBOT_CONFIG_PATH,
      token: process.env.CLAWDBOT_GATEWAY_TOKEN,
      skipChannels: process.env.CLAWDBOT_SKIP_CHANNELS,
      skipGmail: process.env.CLAWDBOT_SKIP_GMAIL_WATCHER,
      skipCron: process.env.CLAWDBOT_SKIP_CRON,
      skipCanvas: process.env.CLAWDBOT_SKIP_CANVAS_HOST,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      anthropicApiKeyOld: process.env.ANTHROPIC_API_KEY_OLD,
    };

    process.env.CLAWDBOT_SKIP_CHANNELS = "1";
    process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = "1";
    process.env.CLAWDBOT_SKIP_CRON = "1";
    process.env.CLAWDBOT_SKIP_CANVAS_HOST = "1";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_OLD;

    const token = `test-${randomUUID()}`;
    process.env.CLAWDBOT_GATEWAY_TOKEN = token;

    const rawModel = process.env.CLAWDBOT_LIVE_CLI_BACKEND_MODEL ?? DEFAULT_MODEL;
    const parsed = parseModelRef(rawModel, "claude-cli");
    if (!parsed) {
      throw new Error(
        `CLAWDBOT_LIVE_CLI_BACKEND_MODEL must resolve to a CLI backend model. Got: ${rawModel}`,
      );
    }
    const providerId = parsed.provider;
    const modelKey = `${providerId}/${parsed.model}`;

    const providerDefaults =
      providerId === "claude-cli"
        ? { command: "claude", args: DEFAULT_CLAUDE_ARGS }
        : providerId === "codex-cli"
          ? { command: "codex", args: DEFAULT_CODEX_ARGS }
          : null;

    const cliCommand = process.env.CLAWDBOT_LIVE_CLI_BACKEND_COMMAND ?? providerDefaults?.command;
    if (!cliCommand) {
      throw new Error(
        `CLAWDBOT_LIVE_CLI_BACKEND_COMMAND is required for provider "${providerId}".`,
      );
    }
    const baseCliArgs =
      parseJsonStringArray(
        "CLAWDBOT_LIVE_CLI_BACKEND_ARGS",
        process.env.CLAWDBOT_LIVE_CLI_BACKEND_ARGS,
      ) ?? providerDefaults?.args;
    if (!baseCliArgs || baseCliArgs.length === 0) {
      throw new Error(`CLAWDBOT_LIVE_CLI_BACKEND_ARGS is required for provider "${providerId}".`);
    }
    const cliClearEnv =
      parseJsonStringArray(
        "CLAWDBOT_LIVE_CLI_BACKEND_CLEAR_ENV",
        process.env.CLAWDBOT_LIVE_CLI_BACKEND_CLEAR_ENV,
      ) ?? (providerId === "claude-cli" ? DEFAULT_CLEAR_ENV : []);
    const cliImageArg = process.env.CLAWDBOT_LIVE_CLI_BACKEND_IMAGE_ARG?.trim() || undefined;
    const cliImageMode = parseImageMode(process.env.CLAWDBOT_LIVE_CLI_BACKEND_IMAGE_MODE);

    if (cliImageMode && !cliImageArg) {
      throw new Error(
        "CLAWDBOT_LIVE_CLI_BACKEND_IMAGE_MODE requires CLAWDBOT_LIVE_CLI_BACKEND_IMAGE_ARG.",
      );
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-live-cli-"));
    const disableMcpConfig = process.env.CLAWDBOT_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG !== "0";
    let cliArgs = baseCliArgs;
    if (providerId === "claude-cli" && disableMcpConfig) {
      const mcpConfigPath = path.join(tempDir, "claude-mcp.json");
      await fs.writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
      cliArgs = withMcpConfigOverrides(baseCliArgs, mcpConfigPath);
    }

    const cfg = loadConfig();
    const existingBackends = cfg.agents?.defaults?.cliBackends ?? {};
    const nextCfg = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: { primary: modelKey },
          models: {
            [modelKey]: {},
          },
          cliBackends: {
            ...existingBackends,
            [providerId]: {
              command: cliCommand,
              args: cliArgs,
              clearEnv: cliClearEnv.length > 0 ? cliClearEnv : undefined,
              systemPromptWhen: "never",
              ...(cliImageArg ? { imageArg: cliImageArg, imageMode: cliImageMode } : {}),
            },
          },
          sandbox: { mode: "off" },
        },
      },
    };
    const tempConfigPath = path.join(tempDir, "moltbot.json");
    await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
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
      const sessionKey = "agent:dev:live-cli-backend";
      const runId = randomUUID();
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const message =
        providerId === "codex-cli"
          ? `Please include the token CLI-BACKEND-${nonce} in your reply.`
          : `Reply with exactly: CLI backend OK ${nonce}.`;
      const payload = await client.request<Record<string, unknown>>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `idem-${runId}`,
          message,
          deliver: false,
        },
        { expectFinal: true },
      );
      if (payload?.status !== "ok") {
        throw new Error(`agent status=${String(payload?.status)}`);
      }
      const text = extractPayloadText(payload?.result);
      if (providerId === "codex-cli") {
        expect(text).toContain(`CLI-BACKEND-${nonce}`);
      } else {
        expect(text).toContain(`CLI backend OK ${nonce}.`);
      }

      if (CLI_RESUME) {
        const runIdResume = randomUUID();
        const resumeNonce = randomBytes(3).toString("hex").toUpperCase();
        const resumeMessage =
          providerId === "codex-cli"
            ? `Please include the token CLI-RESUME-${resumeNonce} in your reply.`
            : `Reply with exactly: CLI backend RESUME OK ${resumeNonce}.`;
        const resumePayload = await client.request<Record<string, unknown>>(
          "agent",
          {
            sessionKey,
            idempotencyKey: `idem-${runIdResume}`,
            message: resumeMessage,
            deliver: false,
          },
          { expectFinal: true },
        );
        if (resumePayload?.status !== "ok") {
          throw new Error(`resume status=${String(resumePayload?.status)}`);
        }
        const resumeText = extractPayloadText(resumePayload?.result);
        if (providerId === "codex-cli") {
          expect(resumeText).toContain(`CLI-RESUME-${resumeNonce}`);
        } else {
          expect(resumeText).toContain(`CLI backend RESUME OK ${resumeNonce}.`);
        }
      }

      if (CLI_IMAGE) {
        // Shorter code => less OCR flake across providers, still tests image attachments end-to-end.
        const imageCode = randomImageProbeCode();
        const imageBase64 = renderCatNoncePngBase64(imageCode);
        const runIdImage = randomUUID();

        const imageProbe = await client.request<Record<string, unknown>>(
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
          throw new Error(`image probe failed: status=${String(imageProbe?.status)}`);
        }
        const imageText = extractPayloadText(imageProbe?.result);
        if (!/\bcat\b/i.test(imageText)) {
          throw new Error(`image probe missing 'cat': ${imageText}`);
        }
        const candidates = imageText.toUpperCase().match(/[A-Z0-9]{6,20}/g) ?? [];
        const bestDistance = candidates.reduce((best, cand) => {
          if (Math.abs(cand.length - imageCode.length) > 2) return best;
          return Math.min(best, editDistance(cand, imageCode));
        }, Number.POSITIVE_INFINITY);
        if (!(bestDistance <= 5)) {
          throw new Error(`image probe missing code (${imageCode}): ${imageText}`);
        }
      }
    } finally {
      client.stop();
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
      if (previous.configPath === undefined) delete process.env.CLAWDBOT_CONFIG_PATH;
      else process.env.CLAWDBOT_CONFIG_PATH = previous.configPath;
      if (previous.token === undefined) delete process.env.CLAWDBOT_GATEWAY_TOKEN;
      else process.env.CLAWDBOT_GATEWAY_TOKEN = previous.token;
      if (previous.skipChannels === undefined) delete process.env.CLAWDBOT_SKIP_CHANNELS;
      else process.env.CLAWDBOT_SKIP_CHANNELS = previous.skipChannels;
      if (previous.skipGmail === undefined) delete process.env.CLAWDBOT_SKIP_GMAIL_WATCHER;
      else process.env.CLAWDBOT_SKIP_GMAIL_WATCHER = previous.skipGmail;
      if (previous.skipCron === undefined) delete process.env.CLAWDBOT_SKIP_CRON;
      else process.env.CLAWDBOT_SKIP_CRON = previous.skipCron;
      if (previous.skipCanvas === undefined) delete process.env.CLAWDBOT_SKIP_CANVAS_HOST;
      else process.env.CLAWDBOT_SKIP_CANVAS_HOST = previous.skipCanvas;
      if (previous.anthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous.anthropicApiKey;
      if (previous.anthropicApiKeyOld === undefined) delete process.env.ANTHROPIC_API_KEY_OLD;
      else process.env.ANTHROPIC_API_KEY_OLD = previous.anthropicApiKeyOld;
    }
  }, 60_000);
});

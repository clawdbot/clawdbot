import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { ChannelOutboundContext } from "../channels/plugins/types.public.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { resolveBundledPluginWorkspaceSourcePath } from "../plugins/bundled-plugin-metadata.js";
import { pluginCommands } from "../plugins/command-registry-state.js";
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
import { renderCatFacePngBase64 } from "./live-image-probe.js";
import { startGatewayServer } from "./server.js";

const LIVE = isLiveTestEnabled();
const CODEX_BIND_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_BIND);
const describeLive = LIVE && CODEX_BIND_LIVE ? describe : describe.skip;
const CODEX_BIND_TIMEOUT_MS = 10 * 60_000;
const CODEX_BIND_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_CODEX_BIND_MODEL = "gpt-5.4";

type CapturedOutboundReply = {
  accountId?: string;
  text: string;
  threadId?: string | number;
  to: string;
};

function createSlackCurrentConversationBindingRegistry(outboundReplies: CapturedOutboundReply[]) {
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
        outbound: {
          deliveryMode: "direct",
          sendText: async ({ accountId, text, threadId, to }: ChannelOutboundContext) => {
            outboundReplies.push({
              ...(accountId ? { accountId } : {}),
              text,
              ...(threadId != null ? { threadId } : {}),
              to,
            });
            return { channel: "slack", messageId: `slack-${outboundReplies.length}` };
          },
        },
        bindings: {
          compileConfiguredBinding: () => null,
          matchInboundConversation: () => null,
          resolveCommandConversation: ({
            commandTo,
            originatingTo,
            fallbackTo,
          }: {
            commandTo?: string;
            originatingTo?: string;
            fallbackTo?: string;
          }) => {
            const conversationId = [commandTo, originatingTo, fallbackTo].find(Boolean)?.trim();
            return conversationId ? { conversationId } : null;
          },
        },
      },
    },
  ]);
}

async function getFreeGatewayPort(): Promise<number> {
  const { getFreePortBlockWithPermissionFallback } = await import("../test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 42_000,
  });
}

function extractAssistantTexts(messages: unknown[]): string[] {
  return messages
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      return (entry as { role?: unknown }).role === "assistant"
        ? extractFirstTextBlock(entry)
        : undefined;
    })
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function formatAssistantTextPreview(texts: string[], maxChars = 800): string {
  const combined = texts.join("\n\n").trim();
  if (!combined) {
    return "<empty>";
  }
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

async function waitForOutboundText(params: {
  replies: CapturedOutboundReply[];
  contains: string;
  minReplyCount?: number;
  timeoutMs?: number;
}): Promise<{ outboundTexts: string[]; matchedText: string }> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const outboundTexts = params.replies
      .map((reply) => reply.text)
      .filter((value) => value.trim().length > 0);
    const minReplyCount = params.minReplyCount ?? 1;
    const matchedText = outboundTexts
      .slice(Math.max(0, minReplyCount - 1))
      .find((text) => text.includes(params.contains));
    if (outboundTexts.length >= minReplyCount && matchedText) {
      return { outboundTexts, matchedText };
    }
    await sleep(500);
  }

  throw new Error(
    `timed out waiting for outbound text containing ${params.contains}: ${formatAssistantTextPreview(
      params.replies.map((reply) => reply.text),
    )}`,
  );
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function waitForAgentRunOk(client: GatewayClient, runId: string): Promise<void> {
  const result: { status?: string } = await client.request(
    "agent.wait",
    { runId, timeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS },
    { timeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS + 5_000 },
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
  deliver?: boolean;
  attachments?: Array<{
    mimeType: string;
    fileName: string;
    content: string;
  }>;
}): Promise<void> {
  const started: { runId?: string; status?: string } = await params.client.request("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    deliver: params.deliver,
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
  caseInsensitive?: boolean;
  minAssistantCount?: number;
  timeoutMs?: number;
}): Promise<{ messages: unknown[]; assistantTexts: string[]; matchedAssistantText: string }> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const history: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 24,
    });
    const messages = history.messages ?? [];
    const assistantTexts = extractAssistantTexts(messages);
    const minAssistantCount = params.minAssistantCount ?? 1;
    const expected = params.caseInsensitive ? params.contains.toLowerCase() : params.contains;
    const matchedAssistantText = assistantTexts
      .slice(Math.max(0, minAssistantCount - 1))
      .find((text) => (params.caseInsensitive ? text.toLowerCase() : text).includes(expected));
    if (assistantTexts.length >= minAssistantCount && matchedAssistantText) {
      return { messages, assistantTexts, matchedAssistantText };
    }
    await sleep(500);
  }

  const finalHistory: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: params.sessionKey,
    limit: 24,
  });
  throw new Error(
    `timed out waiting for assistant text containing ${params.contains}: ${formatAssistantTextPreview(
      extractAssistantTexts(finalHistory.messages ?? []),
    )}`,
  );
}

function resolveCodexPluginRoot(): string {
  const command =
    pluginCommands.get("/codex") ??
    Array.from(pluginCommands.values()).find((candidate) => candidate.pluginId === "codex");
  if (command?.pluginRoot) {
    return command.pluginRoot;
  }
  const pluginRoot = resolveBundledPluginWorkspaceSourcePath({
    rootDir: process.cwd(),
    pluginId: "codex",
  });
  if (!pluginRoot) {
    throw new Error("Codex bundled plugin root was not found");
  }
  return pluginRoot;
}

function resolveBoundSessionKey(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}): string {
  const binding = getSessionBindingService().resolveByConversation({
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
  });
  if (!binding?.targetSessionKey) {
    throw new Error(
      `No plugin binding target session for ${params.channel}:${params.conversationId}`,
    );
  }
  return binding.targetSessionKey;
}

async function writePluginBindingApproval(params: {
  homeDir: string;
  pluginRoot: string;
  channel: string;
  accountId: string;
}): Promise<void> {
  const openclawDir = path.join(params.homeDir, ".openclaw");
  await fs.mkdir(openclawDir, { recursive: true });
  await fs.writeFile(
    path.join(openclawDir, "plugin-binding-approvals.json"),
    `${JSON.stringify(
      {
        version: 1,
        approvals: [
          {
            pluginRoot: params.pluginRoot,
            pluginId: "codex",
            pluginName: "Codex",
            channel: params.channel,
            accountId: params.accountId,
            approvedAt: Date.now(),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function writeGatewayConfig(params: {
  configPath: string;
  model: string;
  port: number;
  token: string;
  workspace: string;
}): Promise<void> {
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      port: params.port,
      auth: { mode: "token", token: params.token },
    },
    plugins: {
      allow: ["codex"],
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              mode: "yolo",
              requestTimeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS,
              defaultWorkspaceDir: params.workspace,
            },
          },
        },
      },
    },
    agents: {
      defaults: {
        workspace: params.workspace,
        agentRuntime: { id: "codex" },
        model: { primary: `codex/${params.model}` },
        skipBootstrap: true,
        heartbeat: { every: "0m" },
        sandbox: { mode: "off" },
      },
    },
  };
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

describeLive("gateway live (native Codex conversation binding)", () => {
  it(
    "binds a Slack DM to Codex app-server, updates controls, and forwards image media paths",
    async () => {
      const previous = {
        codexHome: process.env.CODEX_HOME,
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
        home: process.env.HOME,
        skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
        skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
        skipCron: process.env.OPENCLAW_SKIP_CRON,
        skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
        stateDir: process.env.OPENCLAW_STATE_DIR,
      };
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-codex-bind-"));
      const tempHome = path.join(tempRoot, "home");
      const stateDir = path.join(tempRoot, "state");
      const workspace = path.join(tempRoot, "workspace");
      const configPath = path.join(tempRoot, "openclaw.json");
      const token = `test-${randomUUID()}`;
      const port = await getFreeGatewayPort();
      const sessionKey = "main";
      const accountId = "default";
      const slackUserId = `U${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const conversationId = `user:${slackUserId}`;
      const bindModel =
        process.env.OPENCLAW_LIVE_CODEX_BIND_MODEL?.trim() || DEFAULT_CODEX_BIND_MODEL;
      const outboundReplies: CapturedOutboundReply[] = [];

      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(
        path.join(workspace, "AGENTS.md"),
        [
          "# AGENTS.md",
          "",
          "Follow exact reply instructions from the user.",
          "Do not add commentary when asked for an exact response.",
        ].join("\n"),
      );
      await fs.mkdir(tempHome, { recursive: true });
      await fs.mkdir(stateDir, { recursive: true });
      await writeGatewayConfig({ configPath, model: bindModel, port, token, workspace });

      clearConfigCache();
      clearRuntimeConfigSnapshot();
      clearPluginLoaderCache();
      resetPluginRuntimeStateForTest();
      const codexHome =
        previous.codexHome || (previous.home ? path.join(previous.home, ".codex") : "");
      if (codexHome) {
        process.env.CODEX_HOME = codexHome;
      } else {
        delete process.env.CODEX_HOME;
      }
      process.env.HOME = tempHome;
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      process.env.OPENCLAW_STATE_DIR = stateDir;

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      const client = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        timeoutMs: 90_000,
        requestTimeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS,
        clientDisplayName: "vitest-codex-bind-live",
      });
      const channelRegistry = createSlackCurrentConversationBindingRegistry(outboundReplies);
      pinActivePluginChannelRegistry(channelRegistry);

      try {
        await writePluginBindingApproval({
          homeDir: tempHome,
          pluginRoot: resolveCodexPluginRoot(),
          channel: "slack",
          accountId,
        });

        await sendChatAndWait({
          client,
          sessionKey,
          idempotencyKey: `idem-codex-bind-${randomUUID()}`,
          message: `/codex bind --cwd ${workspace} --model ${bindModel}`,
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
          deliver: true,
        });
        const bindReply = await waitForOutboundText({
          replies: outboundReplies,
          contains: "Bound this conversation to Codex thread",
          timeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS,
        });
        const boundSessionKey = resolveBoundSessionKey({
          channel: "slack",
          accountId,
          conversationId,
        });
        let commandReplyCount = bindReply.outboundTexts.length;

        const sendCodexCommand = async (message: string, contains: string, timeoutMs = 60_000) => {
          await sendChatAndWait({
            client,
            sessionKey,
            idempotencyKey: `idem-codex-command-${randomUUID()}`,
            message,
            originatingChannel: "slack",
            originatingTo: conversationId,
            originatingAccountId: accountId,
            deliver: true,
          });
          const result = await waitForOutboundText({
            replies: outboundReplies,
            contains,
            minReplyCount: commandReplyCount + 1,
            timeoutMs,
          });
          commandReplyCount = result.outboundTexts.length;
          return result;
        };

        await sendCodexCommand(
          "/codex status",
          "Codex app-server: connected",
          CODEX_BIND_REQUEST_TIMEOUT_MS,
        );
        await sendCodexCommand("/codex models", "Codex models:", CODEX_BIND_REQUEST_TIMEOUT_MS);
        await sendCodexCommand("/codex fast on", "Codex fast mode enabled.");
        await sendCodexCommand("/codex fast status", "Codex fast mode: on.");
        await sendCodexCommand("/codex permissions default", "Codex permissions set to default.");
        await sendCodexCommand("/codex permissions status", "Codex permissions: default.");
        await sendCodexCommand("/codex model", `Codex model: ${bindModel}`);
        await sendCodexCommand("/codex stop", "No active Codex run to stop.");

        const bindingStatus = await sendCodexCommand("/codex binding", "- Fast: on");
        if (!bindingStatus.matchedText.includes("- Permissions: default")) {
          throw new Error(
            `binding status did not include default permissions: ${bindingStatus.matchedText}`,
          );
        }

        const textNonce = randomBytes(4).toString("hex").toUpperCase();
        const textToken = `CODEX-BIND-${textNonce}`;
        await sendChatAndWait({
          client,
          sessionKey,
          idempotencyKey: `idem-codex-bound-text-${randomUUID()}`,
          message: `Reply with exactly this token and nothing else: ${textToken}`,
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
        });
        const textHistory = await waitForAssistantText({
          client,
          sessionKey: boundSessionKey,
          contains: textToken,
          timeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS,
        });

        await sendChatAndWait({
          client,
          sessionKey,
          idempotencyKey: `idem-codex-bound-image-${randomUUID()}`,
          message:
            "What animal is drawn in the attached image? Reply with only the lowercase animal name.",
          originatingChannel: "slack",
          originatingTo: conversationId,
          originatingAccountId: accountId,
          attachments: [
            {
              mimeType: "image/png",
              fileName: `codex-bind-probe-${randomUUID()}.png`,
              content: renderCatFacePngBase64(),
            },
          ],
        });
        await waitForAssistantText({
          client,
          sessionKey: boundSessionKey,
          contains: "cat",
          caseInsensitive: true,
          minAssistantCount: textHistory.assistantTexts.length + 1,
          timeoutMs: CODEX_BIND_REQUEST_TIMEOUT_MS,
        });

        await sendCodexCommand("/codex detach", "Detached this conversation from Codex.");
        await sendCodexCommand("/codex binding", "No Codex conversation binding is attached.");
      } finally {
        releasePinnedPluginChannelRegistry(channelRegistry);
        clearConfigCache();
        clearRuntimeConfigSnapshot();
        await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
        await server.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
        restoreEnvVar("CODEX_HOME", previous.codexHome);
        restoreEnvVar("OPENCLAW_CONFIG_PATH", previous.configPath);
        restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", previous.gatewayToken);
        restoreEnvVar("HOME", previous.home);
        restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", previous.skipCanvas);
        restoreEnvVar("OPENCLAW_SKIP_CHANNELS", previous.skipChannels);
        restoreEnvVar("OPENCLAW_SKIP_CRON", previous.skipCron);
        restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", previous.skipGmail);
        restoreEnvVar("OPENCLAW_STATE_DIR", previous.stateDir);
      }
    },
    CODEX_BIND_TIMEOUT_MS,
  );
});

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { SystemAgentApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { readQaJsonResponse } from "../../ignored-response-body.js";
import type { QaSuiteRuntimeEnv } from "../../suite-runtime-types.js";
import type { TelegramUserbotUpdate } from "./userbot-driver.runtime.js";

type CreateHandler = typeof createChannelApprovalHandlerFromCapability;
type Delivery = { chatId: string; messageId: string };
// The installed sender owns options and results; the fixture observes only its delivery receipts.
type ObservedSend = (
  to: string,
  text: string,
  options: Record<string, unknown> & {
    onDeliveryResult?: (delivery: Delivery) => Promise<void> | void;
  },
) => Promise<unknown>;
type Observation = Pick<TelegramUserbotUpdate, "kind" | "messageId" | "forumTopicId" | "text">;
type CaseProof = {
  target: "channel" | "dm";
  pending?: Observation;
  edited?: Observation;
  notices?: Observation[];
  passed: boolean;
};

function observe({ kind, messageId, forumTopicId, text }: TelegramUserbotUpdate): Observation {
  return { kind, messageId, forumTopicId, text };
}

export async function proveTelegramApprovalTopics(params: {
  env: QaSuiteRuntimeEnv;
  readTelegramMessages: () => TelegramUserbotUpdate[];
  signal?: AbortSignal;
}) {
  const { env, readTelegramMessages, signal } = params;
  const accountId = env.transport.accountId;
  const account = env.cfg.channels?.telegram?.accounts?.[accountId];
  const configuredToken = account?.botToken;
  const chatId = String(account?.allowFrom?.[0] ?? "");
  const apiRoot = account?.apiRoot;
  if (
    env.transport.id !== "telegram" ||
    env.providerMode !== "mock-openai" ||
    account?.dmPolicy !== "allowlist" ||
    typeof configuredToken !== "string" ||
    !/^\d+$/u.test(chatId) ||
    !apiRoot ||
    new URL(apiRoot).hostname !== "127.0.0.1"
  ) {
    throw new Error("Approval topic proof requires the leased Telegram Test Server DM adapter.");
  }
  const token: string = configuredToken;
  const botApiPolicy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(apiRoot);

  // The harness checkout can differ from the SUT. Resolve both runtime owners from its installed bin.
  const command = process.env.OPENCLAW_NPM_TELEGRAM_SUT_COMMAND;
  const prefix = process.env.NPM_CONFIG_PREFIX;
  if (!command || !prefix || !path.isAbsolute(command)) {
    throw new Error("Approval topic proof requires the package acceptance installed command.");
  }
  const realCommand = await fs.realpath(command);
  const realPrefix = await fs.realpath(prefix);
  if (
    !realCommand.startsWith(`${realPrefix}${path.sep}`) ||
    path.basename(realCommand) !== "openclaw.mjs"
  ) {
    throw new Error("Approval topic proof command is not the installed OpenClaw package.");
  }
  const packageRoot = path.dirname(realCommand);
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const build = JSON.parse(
    await fs.readFile(path.join(packageRoot, "dist/build-info.json"), "utf8"),
  );
  if (packageJson.name !== "openclaw" || !/^[a-f0-9]{40}$/u.test(build.commit)) {
    throw new Error("Approval topic proof requires an identified OpenClaw package build.");
  }
  const sdk: { createChannelApprovalHandlerFromCapability: CreateHandler } = await import(
    pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/approval-handler-runtime.js")).href
  );
  const {
    telegramPlugin,
  }: { telegramPlugin: { approvalCapability: Parameters<CreateHandler>[0]["capability"] } } =
    await import(
      pathToFileURL(path.join(packageRoot, "dist/extensions/telegram/channel-plugin-api.js")).href
    );
  const telegramRuntime: { sendMessageTelegram: ObservedSend } = await import(
    pathToFileURL(path.join(packageRoot, "dist/extensions/telegram/runtime-api.js")).href
  );
  const deliveries = new Map<string, Delivery>();
  const sendMessage: ObservedSend = (to, text, options) =>
    telegramRuntime.sendMessageTelegram(to, text, {
      ...options,
      onDeliveryResult: async (delivery) => {
        deliveries.set(`${delivery.chatId}:${delivery.messageId}`, {
          chatId: delivery.chatId,
          messageId: delivery.messageId,
        });
        await options.onDeliveryResult?.(delivery);
      },
    });

  const cases: CaseProof[] = [];
  const deletedMessageIds: string[] = [];
  const proof = {
    transport: "Telegram Test Server",
    package: { commit: build.commit, version: packageJson.version },
    entryBoundary:
      "native approval handler requested/resolved events; not delegated authority admission",
    modelInvocation: false,
    privateTopicsEnabled: false,
    topicId: 0,
    cases,
    deletedMessageIds,
    cleanup: false,
    passed: false,
  };
  const artifact = path.join(env.outputDir, "telegram-approval-terminal-topics.json");
  async function botApi<T>(method: string, body: Record<string, unknown>, cleanup = false) {
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url: `${apiRoot}/bot${token}/${method}`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        policy: botApiPolicy,
        // The lease token is in the path: keep requests local and out of HTTP captures.
        maxRedirects: 0,
        capture: false,
        timeoutMs: 20_000,
        signal: cleanup ? undefined : signal,
        auditContext: "qa-lab-telegram-approval-topics",
      });
      const result = await readQaJsonResponse<{ ok: unknown; result: T }>(
        response,
        release,
        "Telegram Test Server",
      );
      if (result.ok !== true) {
        throw new Error("Bot API request failed");
      }
      return result.result;
    } catch {
      // Native request errors can contain the token-bearing URL. Artifact failures name only the method.
      throw new Error(`Telegram Test Server ${method} failed.`);
    }
  }
  const terminalText = "❌ OpenClaw change denied. No change was made.";
  try {
    proof.privateTopicsEnabled =
      (await botApi<{ has_topics_enabled?: boolean }>("getMe", {})).has_topics_enabled === true;
    if (!proof.privateTopicsEnabled) {
      throw new Error("Leased bot has no private-topic capability; no bot settings were changed.");
    }
    const topic = await botApi<{ message_thread_id: number }>("createForumTopic", {
      chat_id: chatId,
      name: `QA approvals ${randomUUID()}`,
    });
    if (!Number.isSafeInteger(topic.message_thread_id) || topic.message_thread_id <= 0) {
      throw new Error("Telegram did not create a distinct private approval topic.");
    }
    proof.topicId = topic.message_thread_id;
    for (const target of ["channel", "dm"] as const) {
      signal?.throwIfAborted();
      const caseProof: CaseProof = { target, passed: false };
      proof.cases.push(caseProof);
      const cfg = {
        ...env.cfg,
        channels: {
          ...env.cfg.channels,
          telegram: {
            ...env.cfg.channels?.telegram,
            accounts: {
              ...env.cfg.channels?.telegram?.accounts,
              [accountId]: {
                ...account,
                execApprovals: { enabled: true, approvers: [chatId], target },
              },
            },
          },
        },
      };
      const handler = await sdk.createChannelApprovalHandlerFromCapability({
        capability: telegramPlugin.approvalCapability,
        label: "telegram/approvals",
        clientDisplayName: "Telegram approvals",
        channel: "telegram",
        channelLabel: "Telegram",
        cfg,
        accountId,
        context: { token, deps: { sendMessage } },
      });
      if (!handler) {
        throw new Error("Installed Telegram native approval handler is unavailable.");
      }
      const marker = `QA-APPROVAL-${target}-${randomUUID()}`;
      const now = Date.now();
      const request: SystemAgentApprovalRequest = {
        approvalKind: "system-agent",
        id: `system-agent:${randomUUID()}`,
        request: {
          title: "OpenClaw change",
          description: marker,
          command: marker,
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: randomUUID(),
          turnSourceChannel: "telegram",
          turnSourceAccountId: accountId,
          turnSourceTo: chatId,
          turnSourceThreadId: proof.topicId,
        },
        createdAtMs: now,
        expiresAtMs: now + 90_000,
      };
      const existingIds = new Set(readTelegramMessages().map((message) => message.messageId));
      const messages = () =>
        readTelegramMessages().filter((message) => !existingIds.has(message.messageId));
      try {
        // Do not start(): the QA Gateway already owns the sole Bot API update subscriber.
        await handler.handleRequested(request);
        const pending = await env.transport.waitForCondition(
          () => messages().find((message) => message.text.includes(marker)),
          30_000,
        );
        caseProof.pending = observe(pending);
        if ((pending.forumTopicId === proof.topicId) !== (target === "channel")) {
          throw new Error(`Pending ${target} card did not follow the native delivery plan.`);
        }
        await handler.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });
        const edited = await env.transport.waitForCondition(
          () =>
            messages().find(
              (message) =>
                message.messageId === pending.messageId &&
                message.kind === "edit" &&
                message.text === terminalText,
            ),
          30_000,
        );
        caseProof.edited = observe(edited);
        if (target === "dm") {
          await env.transport.waitForCondition(
            () =>
              messages().find(
                (message) =>
                  message.messageId !== pending.messageId &&
                  message.text === terminalText &&
                  message.forumTopicId === proof.topicId,
              ),
            30_000,
          );
        }
        await sleep(2_000, undefined, { signal });
        caseProof.notices = messages()
          .filter(
            (message) => message.messageId !== pending.messageId && message.text === terminalText,
          )
          .map(observe);
        caseProof.passed =
          caseProof.notices.length === (target === "dm" ? 1 : 0) &&
          edited.forumTopicId === pending.forumTopicId;
        if (!caseProof.passed) {
          throw new Error(`Terminal ${target} result was duplicated or moved topics.`);
        }
      } finally {
        // An unstarted handler retains timers on stop; drain our synthetic request first.
        try {
          await handler.handleExpired(request.id);
        } finally {
          await handler.stop();
        }
        caseProof.notices ??= messages()
          .filter(
            (message) =>
              message.messageId !== caseProof.pending?.messageId && message.text === terminalText,
          )
          .map(observe);
      }
    }
  } finally {
    try {
      // Use Bot API receipts, not the tester's private-chat message IDs, for deletion.
      const deletions = await Promise.allSettled(
        [...deliveries.values()].map(async (delivery) => {
          await botApi(
            "deleteMessage",
            { chat_id: delivery.chatId, message_id: delivery.messageId },
            true,
          );
          deletedMessageIds.push(delivery.messageId);
        }),
      );
      proof.cleanup = deletions.every((result) => result.status === "fulfilled");
      if (proof.topicId > 0) {
        await botApi(
          "deleteForumTopic",
          { chat_id: chatId, message_thread_id: proof.topicId },
          true,
        ).catch(() => {
          proof.cleanup = false;
        });
      }
    } finally {
      proof.passed =
        proof.cleanup && proof.cases.length === 2 && proof.cases.every((entry) => entry.passed);
      await fs.writeFile(artifact, `${JSON.stringify(proof, null, 2)}\n`);
    }
  }
  if (!proof.cleanup) {
    throw new Error("Telegram proof could not delete every fixture-owned message and topic.");
  }
  return { details: JSON.stringify(proof), artifacts: [artifact] };
}

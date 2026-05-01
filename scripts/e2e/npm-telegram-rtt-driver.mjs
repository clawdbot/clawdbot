#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const groupId = process.env.OPENCLAW_QA_TELEGRAM_GROUP_ID;
const driverToken = process.env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN;
const sutToken = process.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN;
const outputDir = process.env.OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR ?? ".artifacts/rtt/raw";
const timeoutMs = Number(process.env.OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS ?? "180000");
const canaryTimeoutMs = Number(
  process.env.OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS ?? String(timeoutMs),
);
const scenarioIds = (
  process.env.OPENCLAW_NPM_TELEGRAM_SCENARIOS ?? "telegram-mentioned-message-reply"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!groupId || !driverToken || !sutToken) {
  throw new Error(
    "missing Telegram env: OPENCLAW_QA_TELEGRAM_GROUP_ID, OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN, OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
  );
}

class TelegramBot {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok !== true) {
      throw new Error(`${method} failed: ${JSON.stringify(payload)}`);
    }
    return payload.result;
  }

  getMe() {
    return this.call("getMe", {});
  }

  sendMessage(params) {
    return this.call("sendMessage", params);
  }

  getUpdates(params) {
    return this.call("getUpdates", params);
  }
}

const driver = new TelegramBot(driverToken);
const sut = new TelegramBot(sutToken);
const observedMessages = [];
let driverUpdateOffset = 0;

function messageText(message) {
  return message.text ?? message.caption ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushUpdates(bot) {
  let updates = await bot.getUpdates({ timeout: 0, allowed_updates: ["message"] });
  let nextOffset;
  while (updates.length > 0) {
    const lastUpdateId = updates.at(-1).update_id;
    nextOffset = lastUpdateId + 1;
    updates = await bot.getUpdates({
      offset: nextOffset,
      timeout: 0,
      allowed_updates: ["message"],
    });
  }
  return nextOffset;
}

async function waitForSutReply(params) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const updates = await driver.getUpdates({
      offset: driverUpdateOffset,
      timeout: 5,
      allowed_updates: ["message"],
    });
    for (const update of updates) {
      driverUpdateOffset = Math.max(driverUpdateOffset, update.update_id + 1);
      const message = update.message;
      if (!message || String(message.chat?.id) !== String(groupId)) {
        continue;
      }
      observedMessages.push({
        updateId: update.update_id,
        messageId: message.message_id,
        fromId: message.from?.id,
        fromUsername: message.from?.username,
        replyToMessageId: message.reply_to_message?.message_id,
        text: messageText(message),
        scenarioId: params.scenarioId,
        scenarioTitle: params.scenarioTitle,
      });
      if (message.from?.id !== params.sutId) {
        continue;
      }
      if (message.date < params.startedUnixSeconds) {
        continue;
      }
      const text = messageText(message);
      const replyMatches = message.reply_to_message?.message_id === params.requestMessageId;
      const markerMatches = params.matchText ? text.includes(params.matchText) : false;
      const anySutReplyMatches = params.allowAnySutReply;
      if (replyMatches || markerMatches || anySutReplyMatches) {
        return message;
      }
    }
  }

  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Telegram message`);
}

async function runScenario(params) {
  const startedAt = new Date();
  const startedUnixSeconds = Math.floor(startedAt.getTime() / 1000);
  const request = await driver.sendMessage({
    chat_id: groupId,
    text: params.input,
    disable_notification: true,
  });

  try {
    const reply = await waitForSutReply({
      allowAnySutReply: params.allowAnySutReply,
      matchText: params.matchText,
      requestMessageId: request.message_id,
      scenarioId: params.id,
      scenarioTitle: params.title,
      startedUnixSeconds,
      sutId: params.sutId,
      timeoutMs: params.timeoutMs,
    });
    const rttMs = Date.now() - startedAt.getTime();
    return {
      id: params.id,
      title: params.title,
      status: "pass",
      details: `observed SUT message ${reply.message_id}`,
      rttMs,
    };
  } catch (error) {
    return {
      id: params.id,
      title: params.title,
      status: "fail",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function reportMarkdown(summary) {
  const lines = ["# Telegram RTT", ""];
  for (const scenario of summary.scenarios) {
    lines.push(`## ${scenario.title}`, "");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const [driverMe, sutMe] = await Promise.all([driver.getMe(), sut.getMe()]);
  driverUpdateOffset = (await flushUpdates(driver)) ?? driverUpdateOffset;

  const scenarios = [];
  scenarios.push(
    await runScenario({
      allowAnySutReply: true,
      id: "telegram-canary",
      input: `/status@${sutMe.username}`,
      sutId: sutMe.id,
      timeoutMs: canaryTimeoutMs,
      title: "Telegram canary",
    }),
  );

  if (scenarioIds.includes("telegram-mentioned-message-reply")) {
    const marker = `OPENCLAW_RTT_${Date.now().toString(36)}`;
    scenarios.push(
      await runScenario({
        allowAnySutReply: true,
        id: "telegram-mentioned-message-reply",
        input: `/status@${sutMe.username} RTT marker ${marker}`,
        matchText: "OPENCLAW_RTT_OK",
        sutId: sutMe.id,
        timeoutMs,
        title: "Telegram status command reply",
      }),
    );
  }

  const failed = scenarios.filter((scenario) => scenario.status === "fail").length;
  const summary = {
    provider: "telegram",
    driver: { id: driverMe.id, username: driverMe.username },
    sut: { id: sutMe.id, username: sutMe.username },
    startedAt: new Date().toISOString(),
    status: failed > 0 ? "fail" : "pass",
    totals: { total: scenarios.length, failed, passed: scenarios.length - failed },
    scenarios,
  };

  await fs.writeFile(
    path.join(outputDir, "telegram-qa-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await fs.writeFile(path.join(outputDir, "telegram-qa-report.md"), reportMarkdown(summary));
  await fs.writeFile(
    path.join(outputDir, "telegram-qa-observed-messages.json"),
    `${JSON.stringify(observedMessages, null, 2)}\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

await main();

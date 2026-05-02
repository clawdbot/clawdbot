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
const warmSampleCount = Number(process.env.OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES ?? "20");
const sampleTimeoutMs = Number(process.env.OPENCLAW_NPM_TELEGRAM_SAMPLE_TIMEOUT_MS ?? "30000");
const maxWarmFailures = Number(
  process.env.OPENCLAW_NPM_TELEGRAM_MAX_FAILURES ?? String(warmSampleCount),
);
const successMarker = process.env.OPENCLAW_NPM_TELEGRAM_SUCCESS_MARKER ?? "OPENCLAW_E2E_OK";
const scenarioIds = new Set(
  (process.env.OPENCLAW_NPM_TELEGRAM_SCENARIOS ?? "telegram-mentioned-message-reply")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

if (!groupId || !driverToken || !sutToken) {
  throw new Error(
    "missing Telegram env: OPENCLAW_QA_TELEGRAM_GROUP_ID, OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN, OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
  );
}
if (!Number.isInteger(warmSampleCount) || warmSampleCount < 1) {
  throw new Error(
    `OPENCLAW_NPM_TELEGRAM_WARM_SAMPLES must be a positive integer; got: ${warmSampleCount}`,
  );
}
if (!Number.isInteger(sampleTimeoutMs) || sampleTimeoutMs < 1) {
  throw new Error(
    `OPENCLAW_NPM_TELEGRAM_SAMPLE_TIMEOUT_MS must be a positive integer; got: ${sampleTimeoutMs}`,
  );
}
if (!Number.isInteger(maxWarmFailures) || maxWarmFailures < 1) {
  throw new Error(
    `OPENCLAW_NPM_TELEGRAM_MAX_FAILURES must be a positive integer; got: ${maxWarmFailures}`,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message) {
  return message.text ?? message.caption ?? "";
}

async function flushUpdates(bot) {
  let updates = await bot.getUpdates({
    timeout: 0,
    allowed_updates: ["message", "edited_message"],
  });
  let nextOffset;
  while (updates.length > 0) {
    const lastUpdateId = updates.at(-1).update_id;
    nextOffset = lastUpdateId + 1;
    updates = await bot.getUpdates({
      offset: nextOffset,
      timeout: 0,
      allowed_updates: ["message", "edited_message"],
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
      allowed_updates: ["message", "edited_message"],
    });
    for (const update of updates) {
      driverUpdateOffset = Math.max(driverUpdateOffset, update.update_id + 1);
      const message = update.message ?? update.edited_message;
      if (!message || String(message.chat?.id) !== String(groupId)) {
        continue;
      }
      observedMessages.push({
        updateType: update.edited_message ? "edited_message" : "message",
        updateId: update.update_id,
        messageId: message.message_id,
        fromId: message.from?.id,
        fromUsername: message.from?.username,
        replyToMessageId: message.reply_to_message?.message_id,
        text: messageText(message),
        scenarioId: params.scenarioId,
        scenarioTitle: params.scenarioTitle,
        sampleIndex: params.sampleIndex,
      });
      if (message.from?.id !== params.sutId) {
        continue;
      }
      if (message.date < params.startedUnixSeconds) {
        continue;
      }
      const text = messageText(message);
      if (params.matchText && !text.includes(params.matchText)) {
        continue;
      }
      const replyMatches = message.reply_to_message?.message_id === params.requestMessageId;
      const anySutReplyMatches = params.allowAnySutReply;
      if (replyMatches || anySutReplyMatches || params.matchText) {
        return message;
      }
    }
  }

  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Telegram message`);
}

async function runScenario(params) {
  const startedAt = new Date();
  const startedUnixSeconds = Math.floor(startedAt.getTime() / 1000);
  const sendParams = {
    chat_id: groupId,
    text: params.input,
    disable_notification: true,
  };
  if (params.replyToMessageId) {
    sendParams.reply_parameters = { message_id: params.replyToMessageId };
  }
  const request = await driver.sendMessage(sendParams);

  try {
    const reply = await waitForSutReply({
      allowAnySutReply: params.allowAnySutReply,
      matchText: params.matchText,
      requestMessageId: request.message_id,
      scenarioId: params.id,
      scenarioTitle: params.title,
      sampleIndex: params.sampleIndex,
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
      messageId: reply.message_id,
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

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return undefined;
  }
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

function summarizeSamples(samples) {
  const passed = samples.filter((sample) => sample.status === "pass" && sample.rttMs !== undefined);
  const sorted = passed.map((sample) => sample.rttMs).toSorted((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    total: samples.length,
    passed: passed.length,
    failed: samples.length - passed.length,
    avgMs: sorted.length > 0 ? Math.round(sum / sorted.length) : undefined,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.at(-1),
  };
}

async function runWarmScenario(params) {
  const samples = [];
  let failures = 0;
  let passed = 0;
  for (let index = 0; passed < params.sampleCount; index += 1) {
    const sampleMarker = `${successMarker}_${index + 1}`;
    const sample = await runScenario({
      allowAnySutReply: false,
      id: params.id,
      input: `@${params.sutUsername} RTT sample ${index + 1}. Reply with exactly ${sampleMarker}.`,
      matchText: sampleMarker,
      replyToMessageId: params.replyToMessageId,
      sampleIndex: index + 1,
      sutId: params.sutId,
      timeoutMs: params.sampleTimeoutMs,
      title: params.title,
    });
    if (sample.status === "fail") {
      failures += 1;
    } else {
      passed += 1;
    }
    samples.push({
      index: index + 1,
      status: sample.status,
      details: sample.details,
      ...(sample.rttMs === undefined ? {} : { rttMs: sample.rttMs }),
    });
    if (failures >= params.maxFailures) {
      break;
    }
    if (passed < params.sampleCount) {
      await sleep(500);
    }
  }

  const stats = summarizeSamples(samples);
  return {
    id: params.id,
    title: params.title,
    status: stats.passed >= params.sampleCount ? "pass" : "fail",
    details: `${stats.passed}/${stats.total} warm samples passed`,
    rttMs: stats.p50Ms,
    samples,
    stats,
  };
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
    if (scenario.stats) {
      lines.push(`- Samples: ${scenario.stats.passed}/${scenario.stats.total}`);
      if (scenario.stats.avgMs !== undefined) {
        lines.push(`- Avg: ${scenario.stats.avgMs}ms`);
      }
      if (scenario.stats.p50Ms !== undefined) {
        lines.push(`- P50: ${scenario.stats.p50Ms}ms`);
      }
      if (scenario.stats.p95Ms !== undefined) {
        lines.push(`- P95: ${scenario.stats.p95Ms}ms`);
      }
      if (scenario.stats.maxMs !== undefined) {
        lines.push(`- Max: ${scenario.stats.maxMs}ms`);
      }
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
  const canary = await runScenario({
    allowAnySutReply: true,
    id: "telegram-canary",
    input: `/status@${sutMe.username}`,
    sutId: sutMe.id,
    timeoutMs: canaryTimeoutMs,
    title: "Telegram canary",
  });
  scenarios.push(canary);

  if (scenarioIds.has("telegram-mentioned-message-reply")) {
    scenarios.push(
      await runWarmScenario({
        id: "telegram-mentioned-message-reply",
        maxFailures: maxWarmFailures,
        replyToMessageId: canary.messageId,
        sampleCount: warmSampleCount,
        sampleTimeoutMs,
        sutId: sutMe.id,
        sutUsername: sutMe.username,
        title: "Telegram normal reply",
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

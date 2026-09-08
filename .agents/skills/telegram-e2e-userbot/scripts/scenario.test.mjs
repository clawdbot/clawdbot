import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecorderReady,
  parseScenario,
  resolveChatTarget,
  selectChatTarget,
} from "./scenario.mjs";

test("normalizes Telegram and gateway actions", () => {
  assert.deepEqual(
    parseScenario({
      actions: [
        { type: "send", text: "@{sut} first" },
        {
          type: "click",
          atMs: 500,
          messageText: "Select a provider",
          buttonText: "OpenAI",
        },
        { type: "patchConfig", atMs: 750, patch: { channels: { telegram: { historyLimit: 9 } } } },
        { type: "systemEvent", atMs: 900, text: "heartbeat proof" },
        { type: "cron", atMs: 950, message: "deliver the schedule", bestEffort: true },
        { type: "command", atMs: 975, argv: ["node", "--version"], cwd: "repo" },
        { type: "telegramApiHold", atMs: 980, method: "sendMessage", skip: 1 },
        { type: "telegramApiWaitHeld", atMs: 990, method: "sendMessage" },
        { type: "telegramApiRelease", atMs: 1_000 },
        { type: "restartGateway", atMs: 1_000, graceMs: 20_000 },
        { type: "followupDrainHold", atMs: 1_100, sessionKey: "agent:main:main" },
        { type: "followupDrainWaitHeld", atMs: 1_200 },
        { type: "followupDrainRelease", atMs: 1_400 },
      ],
      health: {},
    }),
    {
      actions: [
        { type: "send", atMs: 0, text: "@{sut} first" },
        {
          type: "click",
          atMs: 500,
          messageText: "Select a provider",
          buttonText: "OpenAI",
          timeoutMs: 15_000,
        },
        {
          type: "patchConfig",
          atMs: 750,
          patch: { channels: { telegram: { historyLimit: 9 } } },
        },
        { type: "systemEvent", atMs: 900, text: "heartbeat proof" },
        { type: "cron", atMs: 950, message: "deliver the schedule", bestEffort: true },
        {
          type: "command",
          atMs: 975,
          argv: ["node", "--version"],
          cwd: "repo",
          timeoutMs: 60_000,
        },
        { type: "telegramApiHold", atMs: 980, method: "sendMessage", skip: 1 },
        {
          type: "telegramApiWaitHeld",
          atMs: 990,
          method: "sendMessage",
          timeoutMs: 30_000,
        },
        { type: "telegramApiRelease", atMs: 1_000 },
        { type: "restartGateway", atMs: 1_000, graceMs: 20_000 },
        {
          type: "followupDrainHold",
          atMs: 1_100,
          sessionKey: "agent:main:main",
          timeoutMs: 60_000,
        },
        { type: "followupDrainWaitHeld", atMs: 1_200, timeoutMs: 60_000 },
        { type: "followupDrainRelease", atMs: 1_400, timeoutMs: 60_000 },
      ],
      health: { intervalMs: 250, timeoutMs: 1_000 },
    },
  );
});

test("stably sorts actions by timestamp", () => {
  assert.deepEqual(
    parseScenario({
      actions: [
        { type: "send", atMs: 1_000, text: "late" },
        { type: "send", atMs: 0, text: "early" },
        { type: "send", atMs: 1_000, text: "same-time" },
      ],
    }).actions,
    [
      { type: "send", atMs: 0, text: "early" },
      { type: "send", atMs: 1_000, text: "late" },
      { type: "send", atMs: 1_000, text: "same-time" },
    ],
  );
});

test("rejects fields and action types outside the closed schema", () => {
  assert.throws(
    () => parseScenario({ actions: [{ type: "shell", command: "true" }] }),
    /not a supported scenario action/u,
  );
  assert.throws(
    () => parseScenario({ actions: [{ type: "command", argv: ["node"], cwd: "elsewhere" }] }),
    /cwd must be repo, workspace, state, or root/u,
  );
  assert.throws(
    () => parseScenario({ actions: [{ type: "send", text: "hello", delayMs: 1 }] }),
    /unknown field: delayMs/u,
  );
  assert.throws(
    () => parseScenario({ actions: [{ type: "restartGateway", atMs: -1 }] }),
    /atMs must be a non-negative integer/u,
  );
  assert.throws(
    () => parseScenario({ actions: [{ type: "cron", message: "deliver", bestEffort: "yes" }] }),
    /bestEffort must be a boolean/u,
  );
});

test("validates the recorder-ready artifact as a closed shape", () => {
  assert.deepEqual(
    parseRecorderReady({ schemaVersion: 1, startedAtUnixMs: 1_786_900_000_000, chatId: -1001 }),
    { schemaVersion: 1, startedAtUnixMs: 1_786_900_000_000, chatId: -1001 },
  );
  assert.throws(
    () => parseRecorderReady({ schemaVersion: 1, startedAtUnixMs: 1, chatId: -1001, extra: true }),
    /unknown field: extra/u,
  );
});

test("projects DM and group recording targets into cron delivery targets", () => {
  assert.deepEqual(selectChatTarget({ dm: true, sutUsername: "sut_bot", testerId: 42 }), {
    kind: "dm",
    recorderSelector: "@sut_bot",
    cronDeliveryTarget: "42",
  });

  const group = selectChatTarget({
    dm: false,
    explicitChat: "",
    leasedGroupId: "-100123",
    sutUsername: "sut_bot",
    testerId: 42,
  });
  assert.deepEqual(group, {
    kind: "chat",
    recorderSelector: "-100123",
    cronDeliveryTarget: null,
  });
  assert.deepEqual(resolveChatTarget(group, -100123), {
    kind: "chat",
    recorderSelector: "-100123",
    cronDeliveryTarget: "-100123",
  });
});

import fs from "node:fs";

const SCENARIO_KEYS = new Set(["actions", "health"]);
const HEALTH_KEYS = new Set(["intervalMs", "timeoutMs"]);
const RECORDER_READY_KEYS = new Set(["schemaVersion", "startedAtUnixMs", "chatId"]);
const ACTION_KEYS = {
  send: new Set(["type", "atMs", "text"]),
  click: new Set(["type", "atMs", "messageText", "buttonText", "timeoutMs"]),
  restartGateway: new Set(["type", "atMs", "graceMs"]),
  patchConfig: new Set(["type", "atMs", "patch"]),
  systemEvent: new Set(["type", "atMs", "text"]),
  cron: new Set(["type", "atMs", "message"]),
  command: new Set(["type", "atMs", "argv", "cwd", "timeoutMs"]),
  telegramApiHold: new Set(["type", "atMs", "method", "skip"]),
  telegramApiWaitHeld: new Set(["type", "atMs", "method", "timeoutMs"]),
  telegramApiRelease: new Set(["type", "atMs"]),
  followupDrainHold: new Set(["type", "atMs", "sessionKey", "timeoutMs"]),
  followupDrainWaitHeld: new Set(["type", "atMs", "timeoutMs"]),
  followupDrainRelease: new Set(["type", "atMs", "timeoutMs"]),
};

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
}

function nonNegativeInteger(value, label, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return resolved;
}

function positiveInteger(value, label, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return resolved;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function parseScenario(value) {
  assertObject(value, "scenario");
  assertKnownKeys(value, SCENARIO_KEYS, "scenario");
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new Error("scenario.actions must be a non-empty array.");
  }

  const actions = value.actions.map((action, index) => {
    const label = `scenario.actions[${index}]`;
    assertObject(action, label);
    const allowed = ACTION_KEYS[action.type];
    if (!allowed) {
      throw new Error(`${label}.type is not a supported scenario action.`);
    }
    assertKnownKeys(action, allowed, label);
    const atMs = nonNegativeInteger(action.atMs, `${label}.atMs`, 0);
    if (action.type === "send" || action.type === "systemEvent") {
      return { type: action.type, atMs, text: nonEmptyString(action.text, `${label}.text`) };
    }
    if (action.type === "cron") {
      return {
        type: action.type,
        atMs,
        message: nonEmptyString(action.message, `${label}.message`),
      };
    }
    if (action.type === "command") {
      if (!Array.isArray(action.argv) || action.argv.length === 0) {
        throw new Error(`${label}.argv must be a non-empty string array.`);
      }
      const argv = action.argv.map((value, argvIndex) =>
        nonEmptyString(value, `${label}.argv[${argvIndex}]`),
      );
      const cwd = action.cwd ?? "repo";
      if (!["repo", "workspace", "state", "root"].includes(cwd)) {
        throw new Error(`${label}.cwd must be repo, workspace, state, or root.`);
      }
      return {
        type: action.type,
        atMs,
        argv,
        cwd,
        timeoutMs: positiveInteger(action.timeoutMs, `${label}.timeoutMs`, 60_000),
      };
    }
    if (action.type === "telegramApiHold") {
      return {
        type: action.type,
        atMs,
        method: nonEmptyString(action.method, `${label}.method`),
        skip: nonNegativeInteger(action.skip, `${label}.skip`, 0),
      };
    }
    if (action.type === "telegramApiWaitHeld") {
      return {
        type: action.type,
        atMs,
        method: nonEmptyString(action.method, `${label}.method`),
        timeoutMs: positiveInteger(action.timeoutMs, `${label}.timeoutMs`, 30_000),
      };
    }
    if (action.type === "telegramApiRelease") return { type: action.type, atMs };
    if (action.type === "followupDrainHold") {
      return {
        type: action.type,
        atMs,
        sessionKey: nonEmptyString(action.sessionKey, `${label}.sessionKey`),
        timeoutMs: positiveInteger(action.timeoutMs, `${label}.timeoutMs`, 60_000),
      };
    }
    if (action.type === "followupDrainWaitHeld" || action.type === "followupDrainRelease") {
      return {
        type: action.type,
        atMs,
        timeoutMs: positiveInteger(action.timeoutMs, `${label}.timeoutMs`, 60_000),
      };
    }
    if (action.type === "click") {
      return {
        type: action.type,
        atMs,
        messageText: nonEmptyString(action.messageText, `${label}.messageText`),
        buttonText: nonEmptyString(action.buttonText, `${label}.buttonText`),
        timeoutMs: positiveInteger(action.timeoutMs, `${label}.timeoutMs`, 15_000),
      };
    }
    if (action.type === "patchConfig") {
      assertObject(action.patch, `${label}.patch`);
      return { type: action.type, atMs, patch: action.patch };
    }
    return {
      type: action.type,
      atMs,
      graceMs: positiveInteger(action.graceMs, `${label}.graceMs`, 15_000),
    };
  });

  let health;
  if (value.health !== undefined) {
    assertObject(value.health, "scenario.health");
    assertKnownKeys(value.health, HEALTH_KEYS, "scenario.health");
    health = {
      intervalMs: positiveInteger(value.health.intervalMs, "scenario.health.intervalMs", 250),
      timeoutMs: positiveInteger(value.health.timeoutMs, "scenario.health.timeoutMs", 1_000),
    };
  }
  return { actions, ...(health ? { health } : {}) };
}

export function readScenarioFile(pathname) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read scenario ${pathname}: ${detail}`);
  }
  return parseScenario(value);
}

export function parseRecorderReady(value) {
  assertObject(value, "recorder ready artifact");
  assertKnownKeys(value, RECORDER_READY_KEYS, "recorder ready artifact");
  if (value.schemaVersion !== 1) {
    throw new Error("recorder ready artifact schemaVersion must be 1.");
  }
  const startedAtUnixMs = positiveInteger(
    value.startedAtUnixMs,
    "recorder ready artifact startedAtUnixMs",
  );
  if (!Number.isInteger(value.chatId) || value.chatId === 0) {
    throw new Error("recorder ready artifact chatId must be a non-zero integer.");
  }
  return { schemaVersion: 1, startedAtUnixMs, chatId: value.chatId };
}

export function selectChatTarget({ dm, explicitChat, leasedGroupId, sutUsername, testerId }) {
  if (dm) {
    return {
      kind: "dm",
      recorderSelector: `@${nonEmptyString(sutUsername, "SUT username")}`,
      cronDeliveryTarget: String(testerId),
    };
  }
  return {
    kind: "chat",
    recorderSelector: nonEmptyString(explicitChat || String(leasedGroupId), "recording chat"),
    cronDeliveryTarget: null,
  };
}

export function resolveChatTarget(target, readyChatId) {
  if (target.kind === "dm") return target;
  if (!Number.isInteger(readyChatId) || readyChatId === 0) {
    throw new Error("resolved recording chat id must be a non-zero integer.");
  }
  return { ...target, cronDeliveryTarget: String(readyChatId) };
}

// Deterministic Codex app-server boundary for native approval receipt proof.
import fs from "node:fs";
import readline from "node:readline";
import {
  createFakeInitializeResponse,
  createFakeThreadStartResponse,
} from "../../../../scripts/e2e/lib/codex-app-server-fixture.mjs";

const requestLog = process.env.OPENCLAW_QA_CODEX_NATIVE_APPROVAL_LOG;
const appServerVersion = process.env.OPENCLAW_QA_CODEX_APP_SERVER_VERSION;
if (!requestLog || !appServerVersion) {
  throw new Error("missing Codex native approval fixture environment");
}

const threadId = "thread-private-native-approval";
const turnId = "turn-private-native-approval";
const itemId = "item-private-native-approval";
const approvalRequestId = "approval-private-native-approval";
const command = "printf PRIVATE_CODEX_NATIVE_APPROVAL_COMMAND";
let activeTurn = false;

function log(message) {
  fs.appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
}

function emit(message) {
  log(message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  emit({ id, result });
}

function completeTurn() {
  const completedAtMs = Date.now();
  const message = {
    type: "agentMessage",
    id: "message-codex-native-approval",
    text: "CODEX_NATIVE_APPROVAL_RECEIPT_OK",
  };
  emit({
    method: "item/completed",
    params: { item: message, threadId, turnId, completedAtMs },
  });
  emit({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [message],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: Math.floor(completedAtMs / 1000),
        completedAt: Math.floor(completedAtMs / 1000),
        durationMs: 0,
      },
    },
  });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  log(message);

  if (message.id === approvalRequestId && message.method === undefined) {
    activeTurn = false;
    completeTurn();
    return;
  }
  if (message.id === undefined || typeof message.method !== "string") {
    return;
  }

  switch (message.method) {
    case "initialize":
      sendResult(
        message.id,
        createFakeInitializeResponse({
          name: "openclaw-qa-codex-native-approval",
          version: appServerVersion,
          userAgent: `openclaw/${appServerVersion} (test)`,
        }),
      );
      return;
    case "account/login/start":
      sendResult(message.id, { type: message.params?.type });
      return;
    case "config/read":
      sendResult(message.id, { config: {}, origins: {}, layers: [] });
      return;
    case "configRequirements/read":
      sendResult(message.id, { requirements: null });
      return;
    case "account/read":
      sendResult(message.id, {
        account: {
          type: "chatgpt",
          email: "qa-codex-native-approval@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      });
      return;
    case "account/rateLimits/read":
      sendResult(message.id, {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      });
      return;
    case "thread/start":
      sendResult(
        message.id,
        createFakeThreadStartResponse({
          params: message.params,
          threadId,
          sessionId: "session-private-native-approval",
          version: appServerVersion,
        }),
      );
      return;
    case "turn/start":
      activeTurn = true;
      sendResult(message.id, {
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      setImmediate(() => {
        if (!activeTurn) {
          return;
        }
        emit({
          id: approvalRequestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId,
            startedAtMs: Date.now(),
            command,
            cwd: process.cwd(),
            availableDecisions: ["accept", "cancel"],
          },
        });
      });
      return;
    default:
      sendResult(message.id, {});
  }
});
